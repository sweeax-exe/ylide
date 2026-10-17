//! Images for models that see: what a file is (by its first bytes, not its
//! name), its size in pixels, and the data URL llama-server takes in an
//! `image_url` content part. llama.cpp decodes PNG, JPEG, GIF (first frame)
//! and WebP itself and scales an image to the model's limits, so the bytes
//! are sent as they are.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;

/// Larger images are refused instead of sent (a screenshot is far smaller).
pub const MAX_IMAGE_BYTES: usize = 20 << 20;

/// Rough tokens of one image, for context estimates. The runtime caps an
/// image at 2048 tokens (`--image-max-tokens`); screenshots the UI scaled
/// down take about this many.
pub const ESTIMATED_TOKENS: u32 = 1_500;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageFormat {
    Png,
    Jpeg,
    Gif,
    Webp,
}

impl ImageFormat {
    pub fn mime(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Gif => "image/gif",
            Self::Webp => "image/webp",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Png => "PNG",
            Self::Jpeg => "JPEG",
            Self::Gif => "GIF",
            Self::Webp => "WebP",
        }
    }

    /// The format of an image file, from its signature.
    pub fn sniff(bytes: &[u8]) -> Option<Self> {
        if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            Some(Self::Png)
        } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
            Some(Self::Jpeg)
        } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
            Some(Self::Gif)
        } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
            Some(Self::Webp)
        } else {
            None
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImageInfo {
    pub format: ImageFormat,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ImageError {
    #[error("not a PNG, JPEG, GIF or WebP image")]
    Unsupported,
    #[error("the image is larger than {} MB", MAX_IMAGE_BYTES >> 20)]
    TooLarge,
    #[error("the image file is damaged")]
    Damaged,
}

/// Format and size of an image file.
pub fn image_info(bytes: &[u8]) -> Result<ImageInfo, ImageError> {
    let format = ImageFormat::sniff(bytes).ok_or(ImageError::Unsupported)?;
    let (width, height) = match format {
        ImageFormat::Png => png_size(bytes),
        ImageFormat::Jpeg => jpeg_size(bytes),
        ImageFormat::Gif => u16le(bytes, 6).zip(u16le(bytes, 8)).map(|(w, h)| (w as u32, h as u32)),
        ImageFormat::Webp => webp_size(bytes),
    }
    .filter(|(w, h)| *w > 0 && *h > 0)
    .ok_or(ImageError::Damaged)?;
    Ok(ImageInfo { format, width, height })
}

/// `data:<mime>;base64,<bytes>` for an `image_url` part.
pub fn data_url(format: ImageFormat, bytes: &[u8]) -> String {
    format!("data:{};base64,{}", format.mime(), STANDARD.encode(bytes))
}

/// Checks an image the UI sends as a data URL: base64 of a format llama.cpp
/// reads, within [`MAX_IMAGE_BYTES`].
pub fn check_data_url(url: &str) -> Result<ImageFormat, ImageError> {
    let rest = url.strip_prefix("data:").ok_or(ImageError::Unsupported)?;
    let (mime, payload) = rest.split_once(";base64,").ok_or(ImageError::Unsupported)?;
    if payload.len() / 4 * 3 > MAX_IMAGE_BYTES {
        return Err(ImageError::TooLarge);
    }
    // The signature is in the first bytes; the whole payload must still be base64.
    if !payload.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'=')) {
        return Err(ImageError::Damaged);
    }
    let head = STANDARD.decode(&payload[..payload.len().min(64) / 4 * 4]).map_err(|_| ImageError::Damaged)?;
    let format = ImageFormat::sniff(&head).ok_or(ImageError::Unsupported)?;
    if format.mime() != mime {
        return Err(ImageError::Unsupported);
    }
    Ok(format)
}

fn u16le(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(at..at + 2)?.try_into().ok()?))
}

fn u16be(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes(b.get(at..at + 2)?.try_into().ok()?))
}

fn u32be(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

fn u24le(b: &[u8], at: usize) -> Option<u32> {
    let s = b.get(at..at + 3)?;
    Some(s[0] as u32 | (s[1] as u32) << 8 | (s[2] as u32) << 16)
}

/// The IHDR chunk comes first: width and height at bytes 16 and 20.
fn png_size(b: &[u8]) -> Option<(u32, u32)> {
    (b.get(12..16)? == b"IHDR").then_some(())?;
    Some((u32be(b, 16)?, u32be(b, 20)?))
}

/// Walks the markers up to the first start-of-frame, which holds the size.
fn jpeg_size(b: &[u8]) -> Option<(u32, u32)> {
    let mut at = 2;
    loop {
        while *b.get(at)? != 0xFF {
            at += 1;
        }
        while *b.get(at)? == 0xFF {
            at += 1;
        }
        let marker = *b.get(at)?;
        at += 1;
        match marker {
            0xD8 | 0x01 | 0xD0..=0xD7 => continue,
            // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
            0xC0..=0xCF if !matches!(marker, 0xC4 | 0xC8 | 0xCC) => {
                return Some((u16be(b, at + 5)? as u32, u16be(b, at + 3)? as u32));
            }
            0xD9 | 0xDA => return None,
            _ => at += u16be(b, at)? as usize,
        }
    }
}

/// Lossy (`VP8 `), lossless (`VP8L`) and extended (`VP8X`) files keep the size in different places.
fn webp_size(b: &[u8]) -> Option<(u32, u32)> {
    match b.get(12..16)? {
        b"VP8 " => {
            (b.get(23..26)? == [0x9D, 0x01, 0x2A]).then_some(())?;
            Some(((u16le(b, 26)? & 0x3FFF) as u32, (u16le(b, 28)? & 0x3FFF) as u32))
        }
        b"VP8L" => {
            (*b.get(20)? == 0x2F).then_some(())?;
            let bits = u32::from_le_bytes(b.get(21..25)?.try_into().ok()?);
            Some(((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1))
        }
        b"VP8X" => Some((u24le(b, 24)? + 1, u24le(b, 27)? + 1)),
        _ => None,
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A valid 2x3 PNG header (enough for the size; llama.cpp would need the rest).
    pub(crate) fn png_header(width: u32, height: u32) -> Vec<u8> {
        let mut b = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
        b.extend(width.to_be_bytes());
        b.extend(height.to_be_bytes());
        b.extend([8, 6, 0, 0, 0]);
        b
    }

    #[test]
    fn formats_and_sizes_come_from_the_bytes() {
        assert_eq!(image_info(&png_header(1920, 1080)), Ok(ImageInfo { format: ImageFormat::Png, width: 1920, height: 1080 }));
        let gif = b"GIF89a\x40\x01\xf0\x00\x80\x00\x00".to_vec();
        assert_eq!(image_info(&gif).map(|i| (i.width, i.height)), Ok((320, 240)));
        // JPEG: SOI, an APP0 segment, then SOF0 with height 600 and width 800.
        let mut jpeg = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0x4A, 0x46];
        jpeg.extend([0xFF, 0xC0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03]);
        assert_eq!(image_info(&jpeg).map(|i| (i.format, i.width, i.height)), Ok((ImageFormat::Jpeg, 800, 600)));
        // WebP lossy (VP8), lossless (VP8L) and extended (VP8X).
        let riff = |chunk: &[u8], body: &[u8]| [b"RIFF\0\0\0\0WEBP".as_slice(), chunk, b"\0\0\0\0", body].concat();
        let lossy = riff(b"VP8 ", &[0, 0, 0, 0x9D, 0x01, 0x2A, 0x80, 0x02, 0xE0, 0x01]);
        assert_eq!(image_info(&lossy).map(|i| (i.format, i.width, i.height)), Ok((ImageFormat::Webp, 640, 480)));
        let bits: u32 = 99 | (49 << 14);
        let lossless = riff(b"VP8L", &[[0x2F].as_slice(), &bits.to_le_bytes()].concat());
        assert_eq!(image_info(&lossless).map(|i| (i.width, i.height)), Ok((100, 50)));
        let extended = riff(b"VP8X", &[0, 0, 0, 0, 0xFF, 0x0E, 0, 0x37, 0x08, 0]);
        assert_eq!(image_info(&extended).map(|i| (i.width, i.height)), Ok((3840, 2104)));

        assert_eq!(image_info(b"fn main() {}"), Err(ImageError::Unsupported));
        assert_eq!(image_info(b"\x89PNG\r\n\x1a\n"), Err(ImageError::Damaged));
        assert_eq!(image_info(&png_header(0, 10)), Err(ImageError::Damaged));
    }

    #[test]
    fn data_urls_are_checked() {
        let png = png_header(2, 3);
        let url = data_url(ImageFormat::Png, &png);
        assert!(url.starts_with("data:image/png;base64,iVBORw0KGgo"), "{url}");
        assert_eq!(check_data_url(&url), Ok(ImageFormat::Png));
        assert_eq!(check_data_url(&url.replace("image/png", "image/jpeg")), Err(ImageError::Unsupported), "the type must match the bytes");
        assert_eq!(check_data_url("https://example.com/cat.png"), Err(ImageError::Unsupported));
        assert_eq!(check_data_url(&data_url(ImageFormat::Png, b"<svg></svg>").replace("png", "svg+xml")), Err(ImageError::Unsupported));
        assert_eq!(check_data_url("data:image/png;base64,iVBOR\"><script>"), Err(ImageError::Damaged));
        let huge = format!("data:image/png;base64,{}", "A".repeat(MAX_IMAGE_BYTES / 3 * 4 + 8));
        assert_eq!(check_data_url(&huge), Err(ImageError::TooLarge));
    }
}

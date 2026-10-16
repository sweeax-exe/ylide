# License supplements

`scripts/third-party-licenses.mjs` takes the license texts for THIRD_PARTY_LICENSES.txt
from the files each package ships. A folder here, named after a crate or npm package,
adds its files to that package's texts. It is for packages that ship no license file,
or that contain code under a further license.

| Folder | Text | Source |
|---|---|---|
| `alloc-stdlib/` | BSD-3-Clause | `LICENSE` of dropbox/rust-alloc-no-stdlib at 0a81fd6 (the commit the crate was published from) |
| `selectors/` | MPL-2.0 | `LICENSE` of the cssparser 0.37.0 crate (also Servo); servo/stylo has no license file for it |
| `ts-rs/`, `ts-rs-macros/` | MIT | `LICENSE` of Aleph-Alpha/ts-rs at 7182ad8 |
| `webview2-com/`, `webview2-com-sys/`, `webview2-com-macros/` | MIT | `LICENSE` of wravery/webview2-rs at edc2caf and dffa41a |
| `webview2-com-sys/LICENSE-WebView2-SDK` | Microsoft BSD-style | License of the Microsoft.Web.WebView2 1.0.3800.47 NuGet package, whose `WebView2LoaderStatic.lib` is linked into ylide.exe |

When the generator reports a package without a license file, add the text from the
package's repository at the commit it was published from (`.cargo_vcs_info.json` of a
crate) and list it here.

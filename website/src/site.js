// Ylide website: the world lines.
//
// The stem of the Y in the hero splits into two lines: cyan for the AI, brass
// for your computer. They braid down the page, and every crossing sits on a
// heading marked `data-cross`. In the agents section a third line joins, and
// the task passes between the three as you scroll. Two faint walls around the
// lines are "your computer"; in the privacy section they open a gate for each
// network door.
//
// Everything is drawn from the scroll position on one fixed canvas, so it
// moves only when you scroll. The one animation of its own is the Y drawing
// itself on load, which reduced-motion settings switch off.

(() => {
  const root = document.documentElement;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduceMotion) document.body.classList.add('intro');

  suggestLanguage();

  const canvas = document.querySelector('canvas.braid');
  if (!canvas) return;
  const rtl = root.dir === 'rtl';
  const g = canvas.getContext('2d');

  const BG = '#0c111b';
  const FROST = [230, 236, 245];
  const STRAND_COLORS = [
    [34, 211, 238], // qubit: orchestrator, the AI
    [201, 166, 107], // brass: coder, your computer
    FROST, // reviewer
  ];
  const WALL = [154, 166, 187];
  const STEP = 3; // px between sampled points
  // Below this width a line is a stroke; above it (where the stem splits) a filled band.
  const RIBBON_W = 2.6;

  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const smooth = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const lerp = (a, b, t) => a + (b - a) * t;
  const mix = (c0, c1, t) => c0.map((v, i) => Math.round(lerp(v, c1[i], t)));
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a.toFixed(3)})`;

  let L = null; // layout in document coordinates, from measure()
  let vw = 0;
  let vh = 0;
  let dpr = 1;

  const docRect = (el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top + scrollY, left: r.left + scrollX, right: r.right + scrollX, width: r.width, height: r.height, bottom: r.bottom + scrollY };
  };

  function measure() {
    vw = root.clientWidth;
    vh = innerHeight;
    dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(vw * dpr);
    canvas.height = Math.round(vh * dpr);
    const mobile = vw < 760;
    // Half the gap between text and visual (--tube in site.css).
    const tubeHalf = clamp(0.15 * vw, 110, 220) / 2;

    // In the mark's 1024 grid the stem is 120 wide, centred at x 512 and
    // visible down to y 896; the two lines start there, side by side.
    const mark = docRect(document.querySelector('.hero-mark'));
    const stem = { x: mark.left + (mark.width * 512) / 1024, y: mark.top + (mark.height * 896) / 1024, w: (mark.width * 120) / 1024 };
    const end = docRect(document.querySelector('[data-end]'));
    const endPt = { x: end.left + end.width / 2, y: end.top };

    const agentsEl = document.querySelector('[data-agents]');
    const agents = agentsEl ? docRect(agentsEl) : null;
    const setupEl = document.querySelector('[data-setup]');
    const setup = setupEl ? docRect(setupEl) : null;
    const points = [...document.querySelectorAll('[data-cross]')].map((el) => {
      const r = docRect(el);
      return { kind: 'cross', y: r.top + r.height / 2 };
    });
    if (agents) {
      points.push({ kind: 'agentsTop', y: agents.top + vh * 0.5 }, { kind: 'agentsBottom', y: agents.bottom - vh * 0.5 });
    }
    if (setup) {
      // One crossing at each change of screen: five steps, five half turns.
      points.push({ kind: 'cross', y: setup.top + vh * 0.5 }, { kind: 'setupBottom', y: setup.bottom - vh * 0.5 });
    }
    points.sort((a, b) => a.y - b.y);
    // Crossings fall where the phase is a multiple of pi. The agents section
    // adds six half turns of its own; the halves around it keep the next
    // heading on a crossing.
    const anchors = [{ y: stem.y, phase: 0 }];
    let phase = 0;
    let prev = 'start';
    for (const p of points) {
      if (p.kind === 'cross') phase += prev === 'agentsBottom' ? Math.PI / 2 : Math.PI;
      else if (p.kind === 'agentsTop') phase += Math.PI / 2;
      else if (p.kind === 'setupBottom') phase += 5 * Math.PI;
      else phase += 6 * Math.PI;
      anchors.push({ y: p.y, phase });
      prev = p.kind;
    }
    anchors.push({ y: endPt.y, phase: phase + Math.PI / 2 });

    const gates = [...document.querySelectorAll('[data-gate]')].map((el) => {
      const r = docRect(el);
      return { y: r.top + r.height / 2, left: r.left, right: r.right, off: el.dataset.gate === 'off' };
    });

    const steps = [...document.querySelectorAll('[data-step]')];
    L = {
      mobile,
      stem,
      endPt,
      baseX: mobile ? (rtl ? vw - 30 : 30) : vw / 2,
      amp: mobile ? 11 : Math.min(46, tubeHalf - 20),
      ampWide: mobile ? 17 : Math.min(88, tubeHalf - 10),
      margin: mobile ? 9 : 30,
      tubeHalf,
      agents: agents && { top: agents.top, bottom: agents.bottom, from: agents.top + vh * 0.5, to: agents.bottom - vh * 0.5 },
      setup: setup && { top: setup.top, bottom: setup.bottom, from: setup.top + vh * 0.5, to: setup.bottom - vh * 0.5 },
      setupSteps: [...document.querySelectorAll('[data-setup-step]')],
      showcase: document.querySelector('.showcase-window'),
      shots: [...document.querySelectorAll('[data-shot]')],
      anchors,
      gates,
      steps,
      owners: steps.map((li) => Number(li.dataset.owner)),
      roles: steps.map((li) => li.querySelector('.role')?.textContent ?? ''),
      tubeLabel: canvas.dataset.tubeLabel ?? '',
    };
  }

  function phaseAt(y) {
    const a = L.anchors;
    if (y <= a[0].y) return a[0].phase;
    for (let i = 1; i < a.length; i++) {
      if (y <= a[i].y) return lerp(a[i - 1].phase, a[i].phase, (y - a[i - 1].y) / (a[i].y - a[i - 1].y));
    }
    return a[a.length - 1].phase;
  }

  /** Share of the three-line mode at document height y (0 outside the agents section). */
  function agentsMode(y) {
    const s = L.agents;
    if (!s) return 0;
    return smooth(s.top + vh * 0.05, s.from, y) * (1 - smooth(s.to, s.bottom - vh * 0.05, y));
  }

  /** Share of the setup lane at document height y (desktop: lines move left of the window). */
  function setupMode(y) {
    const s = L.setup;
    if (!s || L.mobile) return 0;
    return smooth(s.top, s.from - vh * 0.1, y) * (1 - smooth(s.to + vh * 0.1, s.bottom, y));
  }

  /** Positions and looks of the three lines at document height y. */
  function sample(y) {
    const { stem, endPt } = L;
    const m = agentsMode(y);
    const lane = setupMode(y);
    const toEnd = smooth(endPt.y - 640, endPt.y, y);
    const amp = lerp(lerp(L.amp, L.ampWide, m), Math.min(L.amp, 22), lane) * smooth(stem.y, stem.y + 420, y) * (1 - toEnd);
    const spread = (stem.w / 4) * (1 - smooth(stem.y, stem.y + 150, y));
    const width = lerp(stem.w / 2, L.mobile ? 1.8 : 2.2, smooth(stem.y, stem.y + 150, y));
    const tint = smooth(stem.y + 20, stem.y + 280, y);
    // In the setup section the lines run in a lane between the text and the window.
    const laneShift = (rtl ? 1 : -1) * (L.tubeHalf - 40) * lane;
    const cx = lerp(lerp(stem.x, L.baseX, smooth(stem.y + 40, stem.y + 640, y)), endPt.x, toEnd) + laneShift;
    const phase = phaseAt(y);
    const offsets = [0, lerp(Math.PI, (2 * Math.PI) / 3, m), lerp(0, (4 * Math.PI) / 3, m)];
    const sides = [-1, 1, 0];
    const lines = offsets.map((o, i) => {
      const z = Math.cos(phase + o);
      const depth = lerp(1, 0.62 + 0.38 * ((z + 1) / 2), tint);
      return {
        x: cx + amp * Math.sin(phase + o) + sides[i] * spread,
        z,
        a: (i === 2 ? m : 1) * depth,
        c: mix(FROST, STRAND_COLORS[i], tint),
      };
    });
    return { lines, cx, amp, spread, width, lane };
  }

  /** Splits each line into chunks with one look and one depth rank, back ones first. */
  function strokes(samples) {
    const levels = [[], [], []];
    for (let i = 0; i < 3; i++) {
      let chunk = null;
      for (let k = 0; k < samples.length; k++) {
        const s = samples[k];
        const line = s.lines[i];
        const active = line.a > 0.04 && s.width <= RIBBON_W;
        let rank = 0;
        for (let j = 0; j < 3; j++) if (j !== i && s.lines[j].a > 0.04 && s.lines[j].z < line.z) rank++;
        const breakHere = !chunk || !active || chunk.rank !== rank || chunk.pts.length >= 8;
        if (breakHere) {
          if (chunk && chunk.pts.length > 1) levels[chunk.rank].push(chunk);
          const last = chunk && chunk.pts[chunk.pts.length - 1];
          chunk = active ? { rank, pts: last && chunk.rank === rank ? [last] : [], look: null } : null;
          if (!chunk) continue;
        }
        chunk.pts.push({ x: line.x, y: s.y });
        chunk.look ??= { c: line.c, a: line.a, w: s.width };
      }
      if (chunk && chunk.pts.length > 1) levels[chunk.rank].push(chunk);
    }
    return levels;
  }

  function path(pts) {
    g.beginPath();
    g.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
  }

  /**
   * Where the stem splits, the two lines are wide; they are filled as bands so
   * their changing width shows no seams. They slightly overlap in the middle.
   */
  function drawRibbons(samples) {
    for (let i = 0; i < 2; i++) {
      const band = [];
      for (const s of samples) {
        if (s.width <= RIBBON_W) {
          if (band.length) band.push(s);
          break;
        }
        band.push(s);
      }
      if (band.length < 2) continue;
      g.beginPath();
      for (const s of band) g.lineTo(s.lines[i].x - s.width / 2 - 0.5, s.y);
      for (let k = band.length - 1; k >= 0; k--) g.lineTo(band[k].lines[i].x + band[k].width / 2 + 0.5, band[k].y);
      g.closePath();
      const top = band[0];
      const bottom = band[band.length - 1];
      const fill = g.createLinearGradient(0, top.y, 0, bottom.y);
      fill.addColorStop(0, rgba(top.lines[i].c, top.lines[i].a));
      fill.addColorStop(1, rgba(bottom.lines[i].c, bottom.lines[i].a));
      g.fillStyle = fill;
      g.fill();
    }
  }

  function drawLines(samples) {
    drawRibbons(samples);
    g.lineCap = 'butt';
    g.lineJoin = 'round';
    for (const level of strokes(samples)) {
      // Lines in front first clear a gap in what is behind them, like the logo.
      for (const ch of level) {
        path(ch.pts);
        g.strokeStyle = BG;
        g.lineWidth = ch.look.w + 7;
        g.stroke();
      }
      for (const ch of level) {
        path(ch.pts);
        g.strokeStyle = rgba(ch.look.c, ch.look.a);
        g.lineWidth = ch.look.w;
        g.stroke();
      }
    }
  }

  /** The walls of "your computer" around the lines, with a gate for each door. */
  function drawWalls(samples) {
    const { stem, endPt } = L;
    const left = [];
    const right = [];
    for (const s of samples) {
      const alpha = smooth(stem.y + 260, stem.y + 620, s.y) * (1 - smooth(endPt.y - 760, endPt.y - 360, s.y));
      if (alpha <= 0.01) continue;
      const lines = s.amp + s.spread;
      const margin = lerp(L.margin, 8, s.lane);
      const half = L.mobile ? lines + margin : Math.max(lines + 8, Math.min(lines + margin, L.tubeHalf + 2));
      left.push({ x: s.cx - half, y: s.y, alpha });
      right.push({ x: s.cx + half, y: s.y, alpha });
    }
    const gateHalf = 9;
    // Gates open in the wall that faces the list (the right one, or the left one in Arabic).
    const gateSide = rtl ? 'left' : 'right';
    const isGate = (yDoc) => L.gates.some((gt) => Math.abs(gt.y - yDoc) < gateHalf);
    g.lineWidth = 1;
    g.lineCap = 'butt';
    for (const [side, pts] of [['left', left], ['right', right]]) {
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i - 1];
        const q = pts[i];
        if (side === gateSide && isGate(q.y + scrollY)) continue;
        g.strokeStyle = rgba(WALL, 0.2 * q.alpha);
        g.beginPath();
        g.moveTo(p.x, p.y);
        g.lineTo(q.x, q.y);
        g.stroke();
      }
    }
    // Gates: a short dashed path from the opening to its switch, faint while the door is off.
    g.setLineDash([3, 4]);
    for (const gt of L.gates) {
      const y = gt.y - scrollY;
      if (y < -20 || y > vh + 20) continue;
      const s = sample(gt.y);
      const lines = s.amp + s.spread;
      const half = L.mobile ? lines + L.margin : Math.max(lines + 8, Math.min(lines + L.margin, L.tubeHalf + 2));
      const x0 = rtl ? s.cx - half : s.cx + half;
      const x1 = rtl ? gt.right + 10 : gt.left - 10;
      if (rtl ? x1 >= x0 : x1 <= x0) continue;
      g.strokeStyle = gt.off ? rgba(WALL, 0.3) : rgba(STRAND_COLORS[0], 0.55);
      g.beginPath();
      g.moveTo(x0, y);
      g.lineTo(x1, y);
      g.stroke();
    }
    g.setLineDash([]);
    // Label at the top of the right wall.
    const labelY = stem.y + 520;
    if (L.tubeLabel && labelY > scrollY - 20 && labelY < scrollY + vh + 20 && !L.mobile) {
      const s = sample(labelY);
      const lines = s.amp + s.spread;
      const half = Math.max(lines + 8, Math.min(lines + L.margin, L.tubeHalf + 2));
      g.font = `12px ${getComputedStyle(document.body).fontFamily}`;
      g.fillStyle = rgba(WALL, 0.55);
      g.textBaseline = 'middle';
      g.textAlign = rtl ? 'right' : 'left';
      g.fillText(L.tubeLabel, rtl ? s.cx - half - 12 : s.cx + half + 12, labelY - scrollY);
    }
  }

  /** The task travelling between the agents' lines, and the active step. */
  function drawTask() {
    const s = L.agents;
    if (!s || !L.steps.length) return;
    const center = scrollY + vh / 2;
    const progress = clamp((center - s.from) / (s.to - s.from), 0, 1);
    const count = L.steps.length;
    const index = Math.min(count - 1, Math.floor(progress * count));
    L.steps.forEach((li, i) => {
      li.classList.toggle('is-active', i === index);
      li.classList.toggle('is-done', i < index);
    });
    if (center < s.top || center > s.bottom) return;
    const within = progress * count - index;
    const owner = L.owners[index];
    const before = index > 0 ? L.owners[index - 1] : owner;
    const sm = sample(center);
    const hand = index > 0 ? smooth(0, 0.18, within) : 1;
    const x = lerp(sm.lines[before].x, sm.lines[owner].x, hand);
    const y = vh / 2;
    const color = STRAND_COLORS[owner];
    g.fillStyle = BG;
    g.beginPath();
    g.arc(x, y, 9, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = rgba(color, 1);
    g.beginPath();
    g.arc(x, y, 5.5, 0, Math.PI * 2);
    g.fill();
    if (!L.mobile) {
      g.font = `12px ${getComputedStyle(document.body).fontFamily}`;
      g.fillStyle = rgba(color, 0.9);
      g.textBaseline = 'middle';
      g.textAlign = rtl ? 'right' : 'left';
      g.fillText(L.roles[index], rtl ? x - 16 : x + 16, y);
    }
  }

  /** The product shot lies tilted back and straightens up while it scrolls into view. */
  function updateShowcase() {
    const win = L.showcase;
    if (!win || reduceMotion) return;
    const r = win.parentElement.getBoundingClientRect();
    const p = clamp((vh - r.top) / (vh * 0.85), 0, 1);
    const e = 1 - Math.pow(1 - p, 3);
    win.style.transform = `rotateX(${(22 * (1 - e)).toFixed(2)}deg) scale(${(0.88 + 0.12 * e).toFixed(4)}) translateY(${(40 * (1 - e)).toFixed(1)}px)`;
    win.style.opacity = (0.35 + 0.65 * e).toFixed(3);
  }

  /** The setup screens follow the scroll position; each change sits on a crossing. */
  function updateSetup() {
    const s = L.setup;
    if (!s || !L.shots.length) return;
    const count = L.shots.length;
    const center = scrollY + vh / 2;
    const p = clamp((center - s.from) / (s.to - s.from), 0, 1) * count;
    const index = Math.min(count - 1, Math.floor(p));
    L.setupSteps.forEach((li, i) => {
      li.classList.toggle('is-active', i === index);
      li.classList.toggle('is-done', i < index);
    });
    // Cross-fade over a short stretch around each change.
    const FADE = 0.16;
    L.shots.forEach((img, i) => {
      const enter = i === 0 ? 1 : smooth(i - FADE, i + FADE, p);
      const leave = i === count - 1 ? 0 : smooth(i + 1 - FADE, i + 1 + FADE, p);
      const o = enter * (1 - leave);
      img.style.opacity = o.toFixed(3);
      img.style.transform = reduceMotion ? '' : `translateY(${((1 - enter) * 14).toFixed(1)}px) scale(${(1 - (1 - enter) * 0.015).toFixed(4)})`;
    });
  }

  function draw() {
    queued = false;
    if (!L) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, vw, vh);
    const y0 = Math.max(scrollY - 40, L.stem.y);
    const y1 = Math.min(scrollY + vh + 40, L.endPt.y);
    if (y1 > y0) {
      const samples = [];
      for (let y = y0; y < y1 + STEP; y += STEP) {
        const yy = Math.min(y, y1);
        const s = sample(yy);
        s.y = yy - scrollY;
        samples.push(s);
        if (yy === y1) break;
      }
      drawWalls(samples);
      drawLines(samples);
    }
    drawTask();
    updateSetup();
    updateShowcase();
  }

  let queued = false;
  const request = () => {
    if (!queued) {
      queued = true;
      requestAnimationFrame(draw);
    }
  };
  const relayout = () => {
    measure();
    request();
  };

  addEventListener('scroll', request, { passive: true });
  addEventListener('resize', relayout);
  new ResizeObserver(relayout).observe(document.body);
  document.fonts?.ready.then(relayout);
  relayout();

  /**
   * When someone lands here from elsewhere and their browser prefers another
   * language this site has, offer it in one line. Nothing is stored.
   */
  function suggestLanguage() {
    const data = document.getElementById('langs');
    if (!data) return;
    try {
      if (document.referrer && new URL(document.referrer).origin === location.origin) return;
    } catch {
      // An unreadable referrer counts as coming from elsewhere.
    }
    const langs = JSON.parse(data.textContent || '{}');
    const current = data.dataset.current;
    for (const tag of navigator.languages ?? [navigator.language]) {
      const code = tag.toLowerCase().split('-')[0];
      if (code === current) return;
      const offer = langs[code];
      if (!offer) continue;
      const bar = document.createElement('div');
      bar.className = 'lang-suggest';
      bar.lang = offer.lang;
      bar.dir = offer.dir;
      const link = document.createElement('a');
      link.href = offer.path;
      link.hreflang = offer.lang;
      link.textContent = offer.suggest;
      const close = document.createElement('button');
      close.type = 'button';
      close.setAttribute('aria-label', '×');
      close.textContent = '×';
      close.addEventListener('click', () => bar.remove());
      // The header sits on top of the hero; move it below the bar.
      const place = () => document.body.style.setProperty('--suggest-h', `${bar.offsetHeight}px`);
      close.addEventListener('click', () => document.body.style.removeProperty('--suggest-h'));
      bar.append(link, close);
      document.body.prepend(bar);
      place();
      addEventListener('resize', place);
      return;
    }
  }
})();

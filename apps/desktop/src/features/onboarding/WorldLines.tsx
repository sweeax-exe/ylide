// The two world lines that run down the readout. Each row draws one segment
// in which the lines cross once; segments alternate direction and which line
// passes over, so stacked rows form a braid.

import { strandX } from './scan';
import s from './WorldLines.module.css';

const LEFT = 6;
const RIGHT = 18;
const WIDTH = 24;

const curve = (from: number, to: number) => `M${from} 0 C${from} 40 ${to} 60 ${to} 100`;

interface WorldLinesProps {
  index: number;
  /** 0..1: how far the lines are drawn through this row. */
  progress: number;
  /** Show the two particles at the drawing front (or at rest at the end). */
  particles: boolean;
  /** Particles wait at the top while the probe runs. */
  waiting?: boolean;
}

export function WorldLines({ index, progress, particles, waiting = false }: WorldLinesProps) {
  const even = index % 2 === 0;
  const qubitFrom = even ? LEFT : RIGHT;
  const qubitTo = even ? RIGHT : LEFT;
  const qubit = { d: curve(qubitFrom, qubitTo), className: s.qubit };
  const metal = { d: curve(qubitTo, qubitFrom), className: s.metal };
  const [under, over] = even ? [metal, qubit] : [qubit, metal];
  const pct = (x: number) => `${(x / WIDTH) * 100}%`;

  return (
    <div className={s.gutter} aria-hidden>
      <svg className={s.svg} viewBox={`0 0 ${WIDTH} 100`} preserveAspectRatio="none">
        <path className={s.track} d={qubit.d} vectorEffect="non-scaling-stroke" />
        <path className={s.track} d={metal.d} vectorEffect="non-scaling-stroke" />
      </svg>
      {progress > 0 && (
        <svg className={s.svg} viewBox={`0 0 ${WIDTH} 100`} preserveAspectRatio="none" style={{ clipPath: `inset(0 0 ${(1 - progress) * 100}% 0)` }}>
          <path className={under.className} d={under.d} vectorEffect="non-scaling-stroke" />
          <path className={s.gap} d={over.d} vectorEffect="non-scaling-stroke" />
          <path className={over.className} d={over.d} vectorEffect="non-scaling-stroke" />
        </svg>
      )}
      {particles && (
        <>
          <span className={`${s.particle} ${s.qubitParticle} ${waiting ? s.waiting : ''}`} style={{ left: pct(strandX(progress, qubitFrom, qubitTo)), top: `${progress * 100}%` }} />
          <span className={`${s.particle} ${s.metalParticle} ${waiting ? s.waiting : ''}`} style={{ left: pct(strandX(progress, qubitTo, qubitFrom)), top: `${progress * 100}%` }} />
        </>
      )}
    </div>
  );
}

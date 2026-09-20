'use client';

/**
 * The complete static course body: ground + cup.
 *
 * `docs/CONTRACTS.md` splits this responsibility into `CourseGround` (fairway,
 * stripes, border walls) and `HoleMarker` (cup + flag); this component is the
 * convenience composition both of them are used through, so callers only ever
 * need the LevelSpec. Nothing here re-renders during play - the course is static
 * for the whole round.
 */

import { memo } from 'react';
import type { JSX } from 'react';

import type { Theme } from '@/game/levels/themes';
import type { LevelSpec, QualityTier } from '@/types';

import { CourseGround } from './CourseGround';
import { HoleMarker } from './HoleMarker';

export interface CourseMeshProps {
  readonly level: LevelSpec;
  readonly theme: Theme;
  readonly quality?: QualityTier;
  readonly reducedMotion?: boolean;
}

function CourseMeshImpl({ level, theme, quality, reducedMotion }: CourseMeshProps): JSX.Element {
  return (
    <group>
      <CourseGround level={level} theme={theme} quality={quality} />
      <HoleMarker
        hole={level.hole}
        theme={theme}
        quality={quality}
        reducedMotion={reducedMotion}
      />
    </group>
  );
}

export const CourseMesh = memo(CourseMeshImpl);

export default CourseMesh;

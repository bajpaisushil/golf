/**
 * Mini renderer barrel — the three.js-free view of a course.
 *
 * Import from '@/game/rendering/mini' anywhere a board has to be cheap:
 * the Friend Battle opponent strip, the lobby preview, the round summary and
 * the WebGL-less fallback. NOTHING in this folder imports three.js, so pulling
 * it into the home screen costs a couple of kilobytes, not a 3D engine.
 */

export {
  MINI,
  courseProjectionFor,
  courseViewBox,
  drawBall,
  drawBalls,
  drawHole,
  drawLevel,
  drawObstacle,
  drawObstacles,
  drawTrail,
  fitProjection,
  obstacleFill,
  obstacleSvgPath,
  pathPolyline,
  projectLen,
  projectX,
  projectY,
  renderMini,
  unprojectPoint,
} from './draw2d';

export type { Ctx2D, MiniBall, MiniProjection, MiniScene, MiniStyleConfig, PixelBox } from './draw2d';

export { MiniBoard, MiniCourse, MINI_BOARD_WIDTHS, default as MiniBoardDefault } from './MiniBoard';
export type { MiniBoardProps, MiniBoardSize, MiniCourseProps } from './MiniBoard';

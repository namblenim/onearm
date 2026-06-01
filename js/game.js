const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

const W = canvas.width;
const H = canvas.height;

const MAP_SRC = 'start.png';
const HERO_SRC = '주인공.png';

// Map management
const MAPS = {
  start: 'start.png',
  corridor: '복도.png',
  third: '1-1.png',
};
let currentMap = 'start';
let isTransitioning = false;
// Smooth corridor transition state
let transitionActive = false;
let transitionTimer = 0;
const transitionDuration = 0.9; // seconds (auto-walk + fade)
const transitionZoneWidth = 120; // px from right edge to trigger
const transitionSpeed = 180; // auto-walk px/sec during transition
// Map enter animation (player appears from left when corridor loads)
let mapEnterActive = false;
let mapEnterTimer = 0;
let mapEnterDuration = 0.6;
let mapEnterStartX = 0;
let mapEnterTargetX = 40;

const GRAVITY = 1800;
const DEBRIS_GRAVITY = 3400;
const PLAYER_GRAVITY = 1000;
const FRICTION = 0.6;
// Player stop friction constants (smaller => faster stopping)
const PLAYER_STOP_FRICTION = 0.25;
const PLAYER_GRAB_STOP_FRICTION = 0.45;
// Global pull force (user requested strong pull)
const PULL_FORCE = 360.0;
const MAX_ARM = 220;
const TERRAIN_TETHER = 194;
// Increased per-frame tether movement to make pulls stronger/responsive
const TETHER_STEP = 28;
// (using prototype-style force pull; solver constants removed)
const GRAB_DELAY = 20;
const THROW_CAP = 820;
const TILE_SIZE = 16;

const player = {
  x: 220,
  y: 420,
  w: 62,
  h: 96,
  vx: 0,
  vy: 0,
  face: 1,
  onGround: false,
};

const mouse = { x: W * 0.5, y: H * 0.5 };
const hand = { x: mouse.x, y: mouse.y };
const prevHand = { x: mouse.x, y: mouse.y };

const handAnchor = { active: false, x: 0, y: 0, type: null, target: null };

let handVx = 0;
let handVy = 0;
let mouseDown = false;
let holdTimer = 0;
let isGrabbing = false;
let grabType = null;
let grabbed = null;

let sceneReady = false;
let loadingError = null;
let backgroundCanvas = document.createElement('canvas');
let backgroundCtx = backgroundCanvas.getContext('2d');
let wallGrid = null;
let gridCols = 0;
let gridRows = 0;
let debris = [];
let staticWalls = [];
let decorations = [];

// Cutscene: player lens starts dark and then lights up, waking the player
let cutsceneActive = true;
let cutsceneTime = 0;
const cutsceneDuration = 2.2; // seconds

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load ${src}`));
    image.src = src;
  });
}

function snapPlayerToGround() {
  let bestY = null;
  for (const wall of staticWalls) {
    if (player.x + player.w <= wall.x || player.x >= wall.x + wall.w) continue;
    const candidate = wall.y - player.h;
    if (bestY === null || candidate > bestY) bestY = candidate;
  }

  if (bestY !== null) {
    player.y = bestY;
    return;
  }

  for (const item of debris) {
    if (player.x + player.w <= item.x || player.x >= item.x + item.w) continue;
    const candidate = item.y - player.h;
    if (bestY === null || candidate > bestY) bestY = candidate;
  }

  if (bestY !== null) player.y = bestY;
}

function resetInputState() {
  mouseDown = false;
  holdTimer = 0;
  isGrabbing = false;
  grabType = null;
  grabbed = null;
  handAnchor.active = false;
  handAnchor.type = null;
  handAnchor.target = null;
  handAnchor.x = 0;
  handAnchor.y = 0;
  handVx = 0;
  handVy = 0;
}

async function loadMap(key, startX = null, startY = null) {
  if (!MAPS[key]) throw new Error(`Unknown map key: ${key}`);
  isTransitioning = true;
  sceneReady = false;
  try {
    const mapImage = await loadImage(MAPS[key]);
    makeBackground(mapImage);
    buildGridFromImage(mapImage);
    buildStaticWalls(key);
    decorations = [];
    // decide debris layout per-map
    debris = key === 'start' ? buildStartDebris() : [];

    if (startX !== null) player.x = startX; else player.x = (key === 'start' ? 560 : 40);
    // For corridor, default Y should place player on the floor; choose sensible default
    if (startY !== null) player.y = startY; else player.y = (key === 'start' ? 250 : (H - player.h - 84));
    player.vx = 0;
    player.vy = 0;

    snapPlayerToGround();

    hand.x = player.x + player.w + 18;
    hand.y = player.y + 40;
    prevHand.x = hand.x;
    prevHand.y = hand.y;

    currentMap = key;
    // no cutscene on map transition by default
    cutsceneActive = (key === 'start');
    cutsceneTime = 0;
    sceneReady = true;
    if (key === 'corridor') {
      const posterImg = await loadImage('포스터.png').catch(() => null);
      if (posterImg) {
        const posterW = 70;
        const posterH = Math.max(1, Math.round((posterImg.height / posterImg.width) * posterW));
        const markers = [
          [0.195, 0.708],
          [0.399, 0.708],
          [0.608, 0.708],
          [0.801, 0.708],
        ];

        for (const [mx, my] of markers) {
          decorations.push({
            img: posterImg,
            x: Math.round(W * mx - posterW * 0.5),
            y: Math.round(H * my - posterH * 0.5),
            w: posterW,
            h: posterH,
          });
        }
      }

      // ensure player starts off-screen left and plays enter animation
      mapEnterActive = true;
      mapEnterTimer = 0;
      mapEnterDuration = 0.6;
      mapEnterStartX = -player.w - 8;
      mapEnterTargetX = startX !== null ? startX : 40;
      player.x = mapEnterStartX;
    }

    if (key === 'third') {
      const [elevatorImg, fuseImg] = await Promise.all([
        loadImage('elevator.png').catch(() => null),
        loadImage('fuse.png').catch(() => null),
      ]);

      if (elevatorImg) {
        decorations.push({
          img: elevatorImg,
          x: 612,
          y: 502,
          w: 88,
          h: 88,
        });
      }

      const rebarXs = [212, 438];
      for (const x of rebarXs) {
        decorations.push({
          kind: 'rebar',
          x,
          y: 0,
          w: 8,
          h: 603,
        });
      }

      if (fuseImg) {
        debris = buildThirdDebris(fuseImg);
      }

      // Enter the third map from the right side.
      mapEnterActive = true;
      mapEnterTimer = 0;
      mapEnterDuration = 0.6;
      mapEnterStartX = W + player.w + 8;
      mapEnterTargetX = W - player.w - 40;
      player.x = mapEnterStartX;
    }
  } catch (e) {
    loadingError = e instanceof Error ? e.message : String(e);
  }
  isTransitioning = false;
}

function samplePixel(data, width, x, y) {
  const px = clamp(Math.round(x), 0, width - 1);
  const py = clamp(Math.round(y), 0, H - 1);
  const index = (py * width + px) * 4;
  return [data[index], data[index + 1], data[index + 2], data[index + 3]];
}

function luminance(r, g, b) {
  return (r + g + b) / 3;
}

function isWallCell(lum) {
  return lum < 72;
}

function isDebrisCell(lum) {
  return lum >= 72 && lum < 225;
}

function makeBackground(sourceImage) {
  backgroundCanvas.width = W;
  backgroundCanvas.height = H;

  const work = document.createElement('canvas');
  work.width = W;
  work.height = H;
  const workCtx = work.getContext('2d');
  workCtx.drawImage(sourceImage, 0, 0, W, H);

  const imageData = workCtx.getImageData(0, 0, W, H);
  const pixels = imageData.data;

  for (let index = 0; index < pixels.length; index += 4) {
    const r = pixels[index];
    const g = pixels[index + 1];
    const b = pixels[index + 2];
    const lum = luminance(r, g, b);

    if (lum < 72) {
      pixels[index] = 55;
      pixels[index + 1] = 63;
      pixels[index + 2] = 74;
    } else {
      pixels[index] = 216;
      pixels[index + 1] = 216;
      pixels[index + 2] = 216;
    }
  }

  backgroundCtx.putImageData(imageData, 0, 0);
}

function buildGridFromImage(sourceImage) {
  const analysis = document.createElement('canvas');
  analysis.width = W;
  analysis.height = H;
  const analysisCtx = analysis.getContext('2d');
  analysisCtx.drawImage(sourceImage, 0, 0, W, H);

  const pixels = analysisCtx.getImageData(0, 0, W, H).data;
  gridCols = Math.ceil(W / TILE_SIZE);
  gridRows = Math.ceil(H / TILE_SIZE);
  wallGrid = new Uint8Array(gridCols * gridRows);

  const cellType = new Array(gridCols * gridRows).fill('open');
  const probes = [
    [0.2, 0.2],
    [0.8, 0.2],
    [0.2, 0.8],
    [0.8, 0.8],
    [0.5, 0.5],
  ];

  for (let row = 0; row < gridRows; row += 1) {
    for (let col = 0; col < gridCols; col += 1) {
      const index = row * gridCols + col;
      let wallHits = 0;
      let debrisHits = 0;

      for (const probe of probes) {
        const sampleX = col * TILE_SIZE + TILE_SIZE * probe[0];
        const sampleY = row * TILE_SIZE + TILE_SIZE * probe[1];
        const [r, g, b] = samplePixel(pixels, W, sampleX, sampleY);
        const lum = luminance(r, g, b);

        if (isWallCell(lum)) {
          wallHits += 1;
        } else if (isDebrisCell(lum)) {
          debrisHits += 1;
        }
      }

      if (wallHits >= 1) {
        wallGrid[index] = 1;
        cellType[index] = 'wall';
      } else if (debrisHits >= 2) {
        cellType[index] = 'debris';
      }
    }
  }

  const visited = new Uint8Array(gridCols * gridRows);
  debris = [];

  for (let row = 0; row < gridRows; row += 1) {
    for (let col = 0; col < gridCols; col += 1) {
      const startIndex = row * gridCols + col;
      if (visited[startIndex] || cellType[startIndex] !== 'debris') {
        continue;
      }

      const queue = [[col, row]];
      visited[startIndex] = 1;
      let minCol = col;
      let maxCol = col;
      let minRow = row;
      let maxRow = row;

      while (queue.length > 0) {
        const current = queue.pop();
        const currentCol = current[0];
        const currentRow = current[1];

        minCol = Math.min(minCol, currentCol);
        maxCol = Math.max(maxCol, currentCol);
        minRow = Math.min(minRow, currentRow);
        maxRow = Math.max(maxRow, currentRow);

        const neighbours = [
          [currentCol + 1, currentRow],
          [currentCol - 1, currentRow],
          [currentCol, currentRow + 1],
          [currentCol, currentRow - 1],
        ];

        for (const neighbour of neighbours) {
          const neighbourCol = neighbour[0];
          const neighbourRow = neighbour[1];
          if (neighbourCol < 0 || neighbourRow < 0 || neighbourCol >= gridCols || neighbourRow >= gridRows) {
            continue;
          }

          const neighbourIndex = neighbourRow * gridCols + neighbourCol;
          if (visited[neighbourIndex] || cellType[neighbourIndex] !== 'debris') {
            continue;
          }

          visited[neighbourIndex] = 1;
          queue.push([neighbourCol, neighbourRow]);
        }
      }

      const x = minCol * TILE_SIZE;
      const y = minRow * TILE_SIZE;
      const w = (maxCol - minCol + 1) * TILE_SIZE;
      const h = (maxRow - minRow + 1) * TILE_SIZE;

      debris.push({
        x,
        y,
        w,
        h,
        vx: 0,
        vy: 0,
        held: false,
        color: '#a8a8a8',
        shadow: '#707070',
      });
    }
  }
}

function buildStaticWalls(mapKey = 'start') {
  // Build per-map static collision blocks. Defaults match the previous 'start' layout.
  if (mapKey === 'start') {
    staticWalls = [
      { x: 0, y: 0, w: 322, h: H },
      { x: 322, y: 0, w: 900, h: 84 },
      { x: 322, y: 603, w: W - 322, h: H - 603 },
    ];
    // Keep the right area open so the player can reach the edge for transitions.
  } else if (mapKey === 'corridor') {
    // Corridor: open on the left side so player appears from left opening.
    // Use the same floor Y as the start map to avoid vertical mismatch on transition.
    staticWalls = [
      { x: 0, y: 603, w: W, h: H - 603 }, // floor (aligned with start)
    ];
  } else if (mapKey === 'third') {
    // Third map: black areas are solid floor/walls; keep an explicit floor band.
    staticWalls = [
      { x: 0, y: 610, w: W, h: H - 610 },
      { x: 486, y: 547, w: 156, h: 12 },
    ];
  } else {
    // Fallback: empty set
    staticWalls = [];
  }
}

function buildStartDebris() {
  const blocks = [
    [980, 548], [1036, 548], [1092, 548], [1148, 548], [1204, 548],
    [1020, 492], [1076, 492], [1132, 492], [1188, 492],
    [1060, 436], [1116, 436], [1172, 436],
    [1100, 380], [1156, 380],
  ];

  return blocks.slice(0, Math.ceil(blocks.length / 2)).map(([x, y]) => ({
    x,
    y,
    w: 54,
    h: 54,
    vx: 0,
    vy: 0,
    held: false,
    color: '#a8a8a8',
    shadow: '#707070',
  }));
}

function buildThirdDebris(fuseImg) {
  return [{
    x: 968,
    y: 614,
    w: 110,
    h: 52,
    vx: 0,
    vy: 0,
    held: false,
    img: fuseImg,
    color: '#d4a300',
    shadow: '#8a5f00',
  }];
}

function isWallAt(x, y) {
  if (!wallGrid) {
    return false;
  }

  const col = Math.floor(x / TILE_SIZE);
  const row = Math.floor(y / TILE_SIZE);

  if (col < 0 || row < 0 || col >= gridCols || row >= gridRows) {
    return true;
  }

  return wallGrid[row * gridCols + col] === 1;
}

function resolveRectAgainstWalls(body) {
  let grounded = false;
  for (const wall of staticWalls) {
    if (!rectsOverlap(body, wall)) {
      continue;
    }

    const overlapLeft = body.x + body.w - wall.x;
    const overlapRight = wall.x + wall.w - body.x;
    const overlapTop = body.y + body.h - wall.y;
    const overlapBottom = wall.y + wall.h - body.y;
    const smallest = Math.min(overlapLeft, overlapRight, overlapTop, overlapBottom);

    if (smallest === overlapTop) {
      body.y = wall.y - body.h;
      body.vy = 0;
      grounded = true;
    } else if (smallest === overlapBottom) {
      body.y = wall.y + wall.h;
      body.vy = 0;
    } else if (smallest === overlapLeft) {
      body.x = wall.x - body.w;
      body.vx = 0;
    } else {
      body.x = wall.x + wall.w;
      body.vx = 0;
    }
  }

  const startCol = Math.max(0, Math.floor(body.x / TILE_SIZE) - 1);
  const endCol = Math.min(gridCols - 1, Math.floor((body.x + body.w) / TILE_SIZE) + 1);
  const startRow = Math.max(0, Math.floor(body.y / TILE_SIZE) - 1);
  const endRow = Math.min(gridRows - 1, Math.floor((body.y + body.h) / TILE_SIZE) + 1);

  for (let row = startRow; row <= endRow; row += 1) {
    for (let col = startCol; col <= endCol; col += 1) {
      if (wallGrid[row * gridCols + col] !== 1) {
        continue;
      }

      const tile = {
        x: col * TILE_SIZE,
        y: row * TILE_SIZE,
        w: TILE_SIZE,
        h: TILE_SIZE,
      };

      if (!rectsOverlap(body, tile)) {
        continue;
      }

      const overlapLeft = body.x + body.w - tile.x;
      const overlapRight = tile.x + tile.w - body.x;
      const overlapTop = body.y + body.h - tile.y;
      const overlapBottom = tile.y + tile.h - body.y;
      const smallest = Math.min(overlapLeft, overlapRight, overlapTop, overlapBottom);

      if (smallest === overlapTop) {
        body.y = tile.y - body.h;
        body.vy = 0;
        grounded = true;
      } else if (smallest === overlapBottom) {
        body.y = tile.y + tile.h;
        body.vy = 0;
      } else if (smallest === overlapLeft) {
        body.x = tile.x - body.w;
        body.vx = 0;
      } else {
        body.x = tile.x + tile.w;
        body.vx = 0;
      }
    }
  }

  return grounded;
}

function resolveRectAgainstDebris(body, ignoreObject = null) {
  for (const item of debris) {
    if (item === ignoreObject) {
      continue;
    }

    if (!rectsOverlap(body, item)) {
      continue;
    }

    const overlapLeft = body.x + body.w - item.x;
    const overlapRight = item.x + item.w - body.x;
    const overlapTop = body.y + body.h - item.y;
    const overlapBottom = item.y + item.h - body.y;
    const smallest = Math.min(overlapLeft, overlapRight, overlapTop, overlapBottom);

    if (smallest === overlapTop) {
      body.y = item.y - body.h;
      body.vy = 0;
      body.onGround = true;
    } else if (smallest === overlapBottom) {
      body.y = item.y + item.h;
      body.vy = 0;
    } else if (smallest === overlapLeft) {
      body.x = item.x - body.w;
      body.vx = 0;
    } else {
      body.x = item.x + item.w;
      body.vx = 0;
    }
  }
}

function isSupported(body) {
  const probe = { x: body.x, y: body.y + 1, w: body.w, h: body.h };

  for (const wall of staticWalls) {
    if (rectsOverlap(probe, wall)) {
      return true;
    }
  }

  for (const item of debris) {
    if (rectsOverlap(probe, item)) {
      return true;
    }
  }

  return false;
}

function findGrabTarget(hx, hy) {
  const tolerance = 13;
  const terrainTolerance = 22;

  for (const item of debris) {
    if (hx > item.x - tolerance && hx < item.x + item.w + tolerance && hy > item.y - tolerance && hy < item.y + item.h + tolerance) {
      return { target: item, type: 'object' };
    }
  }

  for (const wall of staticWalls) {
    if (hx > wall.x - terrainTolerance && hx < wall.x + wall.w + terrainTolerance && hy > wall.y - terrainTolerance && hy < wall.y + wall.h + terrainTolerance) {
      return { target: wall, type: 'terrain' };
    }
  }

  return null;
}

function getShoulderPoint() {
  const facing = player.face >= 0 ? 1 : -1;
  return {
    x: facing > 0 ? player.x + player.w - 12 : player.x + 12,
    y: player.y + 54,
    facing,
  };
}

function clipSegmentToWalls(startX, startY, endX, endY) {
  let closestT = 1;
  let hitX = endX;
  let hitY = endY;
  const dx = endX - startX;
  const dy = endY - startY;

  for (const wall of staticWalls) {
    const minX = wall.x;
    const maxX = wall.x + wall.w;
    const minY = wall.y;
    const maxY = wall.y + wall.h;
    let tMin = 0;
    let tMax = 1;

    if (Math.abs(dx) < 0.0001) {
      if (startX < minX || startX > maxX) {
        continue;
      }
    } else {
      const tx1 = (minX - startX) / dx;
      const tx2 = (maxX - startX) / dx;
      const txMin = Math.min(tx1, tx2);
      const txMax = Math.max(tx1, tx2);
      tMin = Math.max(tMin, txMin);
      tMax = Math.min(tMax, txMax);
    }

    if (Math.abs(dy) < 0.0001) {
      if (startY < minY || startY > maxY) {
        continue;
      }
    } else {
      const ty1 = (minY - startY) / dy;
      const ty2 = (maxY - startY) / dy;
      const tyMin = Math.min(ty1, ty2);
      const tyMax = Math.max(ty1, ty2);
      tMin = Math.max(tMin, tyMin);
      tMax = Math.min(tMax, tyMax);
    }

    if (tMax >= tMin && tMin >= 0 && tMin <= 1 && tMin < closestT) {
      closestT = Math.max(0, tMin - 0.01);
      hitX = startX + dx * closestT;
      hitY = startY + dy * closestT;
    }
  }

  return { x: hitX, y: hitY };
}

function pushHandOutOfWalls(targetX, targetY) {
  let x = targetX;
  let y = targetY;
  const radius = 10;

  for (const wall of staticWalls) {
    const handBox = { x: x - radius, y: y - radius, w: radius * 2, h: radius * 2 };
    if (!rectsOverlap(handBox, wall)) {
      continue;
    }

    const overlapLeft = x + radius - wall.x;
    const overlapRight = wall.x + wall.w - (x - radius);
    const overlapTop = y + radius - wall.y;
    const overlapBottom = wall.y + wall.h - (y - radius);
    const smallest = Math.min(overlapLeft, overlapRight, overlapTop, overlapBottom);

    if (smallest === overlapTop) {
      y = wall.y - radius;
    } else if (smallest === overlapBottom) {
      y = wall.y + wall.h + radius;
    } else if (smallest === overlapLeft) {
      x = wall.x - radius;
    } else {
      x = wall.x + wall.w + radius;
    }
  }

  return { x, y };
}

function updateHand(dt) {
  const shoulder = getShoulderPoint();
  const shoulderX = shoulder.x;
  const shoulderY = shoulder.y;

  let targetX = mouse.x;
  let targetY = mouse.y;
  const dx = targetX - shoulderX;
  const dy = targetY - shoulderY;
  const distance = Math.hypot(dx, dy);

  if (distance > MAX_ARM) {
    targetX = shoulderX + dx / distance * MAX_ARM;
    targetY = shoulderY + dy / distance * MAX_ARM;
  }

  const clipped = clipSegmentToWalls(shoulderX, shoulderY, targetX, targetY);
  targetX = clipped.x;
  targetY = clipped.y;

  const pushed = pushHandOutOfWalls(targetX, targetY);

  // If there's an active anchor for terrain, keep the hand locked to the anchor.
  // Allow object grabs to follow the mouse so debris can be carried.
  if (handAnchor.active && handAnchor.type === 'terrain') {
    hand.x = handAnchor.x;
    hand.y = handAnchor.y;
  } else {
    hand.x = pushed.x;
    hand.y = pushed.y;
  }

  handVx = (hand.x - prevHand.x) / Math.max(dt, 0.0001);
  handVy = (hand.y - prevHand.y) / Math.max(dt, 0.0001);
  prevHand.x = hand.x;
  prevHand.y = hand.y;

  const suggested = findGrabTarget(mouse.x, mouse.y) || findGrabTarget(hand.x, hand.y);

  if (mouseDown) {
    holdTimer += dt * 1000;
    if (!isGrabbing && suggested && holdTimer >= GRAB_DELAY) {
      // Start grabbing and create a fixed anchor. For terrain grabs, snap the anchor
      // to the furthest reachable point along the shoulder->mouse ray so pulling
      // continues toward that point rather than stopping immediately.
      isGrabbing = true;
      grabType = suggested.type;
      grabbed = suggested.target;

      const shoulder = getShoulderPoint();
      if (suggested.type === 'terrain') {
        // compute along shoulder->mouse to max reach and clip to walls
        const dxm = mouse.x - shoulder.x;
        const dym = mouse.y - shoulder.y;
        const distm = Math.max(0.001, Math.hypot(dxm, dym));
        const tx = shoulder.x + dxm / distm * MAX_ARM;
        const ty = shoulder.y + dym / distm * MAX_ARM;
        const clipped = clipSegmentToWalls(shoulder.x, shoulder.y, tx, ty);
        handAnchor.x = clipped.x;
        handAnchor.y = clipped.y;
        // for terrain, set the desired rest length smaller so the player is pulled higher
        handAnchor.restLength = Math.min(56, TERRAIN_TETHER);
      } else {
        // object grabs should follow the hand/mouse so the object can be moved
        handAnchor.x = hand.x;
        handAnchor.y = hand.y;
        handAnchor.restLength = 0;
        // keep anchor inactive for objects so updateHand uses hand position
        handAnchor.active = false;
      }

      // For terrain anchors we keep active=true, for objects active=false
      if (suggested.type === 'terrain') handAnchor.active = true;
      handAnchor.type = suggested.type;
      handAnchor.target = grabbed;
    }
  } else {
    holdTimer = 0;
  }

  if (isGrabbing && grabbed) {
    if (grabType === 'object') {
      // Smoothly follow the hand: lerp toward the target so object movement is less jittery
      const ax = handAnchor.active ? handAnchor.x : hand.x;
      const ay = handAnchor.active ? handAnchor.y : hand.y;
      const targetX = ax - grabbed.w * 0.5;
      const targetY = ay - grabbed.h * 0.5;
      const k = Math.min(1, 40 * dt);
      grabbed.x += (targetX - grabbed.x) * k;
      grabbed.y += (targetY - grabbed.y) * k;
      grabbed.vx = 0;
      grabbed.vy = 0;
      grabbed.held = true;
    }
  }
}

function updatePlayer(dt) {
  player.vy += PLAYER_GRAVITY * dt;

  if (isGrabbing && grabType === 'terrain' && grabbed) {
    const shoulder = getShoulderPoint();
    const rawAnchorX = handAnchor.active ? handAnchor.x : hand.x;
    const rawAnchorY = handAnchor.active ? handAnchor.y : hand.y;

    // If player is on the ground and the anchor is above the shoulder,
    // clamp the effective anchor Y to shoulder level so pulling doesn't lift the player.
    let anchorX = rawAnchorX;
    let anchorY = rawAnchorY;
    if (player.onGround && rawAnchorY < shoulder.y) {
      // clamp slightly below shoulder to preserve a tiny vertical component if desired
      anchorY = shoulder.y + 2;
    }

    const pullDx = anchorX - shoulder.x;
    const pullDy = anchorY - shoulder.y;

    // Prototype-style pull: apply small velocity impulses separately on X/Y
    // scaled by dt to be framerate-independent, with tuned coefficients
    const scale = (dt || 0.016) * 60;
    const pullXCoef = 0.72; // emphasize horizontal response strongly (doubled)
    const pullYCoef = 0.12;  // vertical pull increased

    let vxImpulse = pullDx * 0.01 * PULL_FORCE * pullXCoef * scale;
    let vyImpulse = pullDy * 0.01 * PULL_FORCE * pullYCoef * scale;

    // If player is currently on ground and original anchor was above shoulder,
    // further reduce upward impulse to avoid unintended lift (soft clamp)
    if (player.onGround && rawAnchorY < shoulder.y && vyImpulse < 0) {
      vyImpulse *= 0.18; // strong damping for upward component while grounded
    }

    player.vx += vxImpulse;
    player.vy += vyImpulse;

    const bodyDist = Math.hypot(pullDx, pullDy);
    if (bodyDist > MAX_ARM) {
      player.x += (pullDx / bodyDist) * (bodyDist - MAX_ARM) * 0.5;
      player.y += (pullDy / bodyDist) * (bodyDist - MAX_ARM) * 0.5;
    }
  }

  player.x += player.vx * dt;
  player.y += player.vy * dt;
  player.onGround = false;

  resolveRectAgainstWalls(player);

  for (let pass = 0; pass < 2; pass += 1) {
    resolveRectAgainstDebris(player, isGrabbing && grabType === 'object' ? grabbed : null);
    resolveRectAgainstWalls(player);
  }

  player.onGround = isSupported(player);
    if (player.onGround) {
    // Apply aggressive stop friction to get quick deceleration; while grabbing
    // use a slightly higher friction so player doesn't slide forever.
    if (isGrabbing && grabType === 'terrain') {
      player.vx *= Math.pow(PLAYER_GRAB_STOP_FRICTION, dt * 60);
    } else {
      player.vx *= Math.pow(PLAYER_STOP_FRICTION, dt * 60);
    }
    if (Math.abs(player.vy) < 30) {
      player.vy = 0;
    }
  }


  player.face = hand.x >= player.x + player.w / 2 ? 1 : -1;

  player.x = clamp(player.x, -20, W - player.w + 20);

  if (player.y > H + 200) {
    player.x = 220;
    player.y = 380;
    player.vx = 0;
    player.vy = 0;
  }
}

function updateDebris(dt) {
  for (const item of debris) {
    if (isGrabbing && grabbed === item) {
      continue;
    }

    item.vy += DEBRIS_GRAVITY * dt;
    item.x += item.vx * dt;
    item.y += item.vy * dt;
    item.vx *= Math.pow(0.90, dt * 60);
    item.vy *= Math.pow(0.90, dt * 60);

    let grounded = false;
    const body = item;

    const wallGrounded = resolveRectAgainstWalls(body);
    grounded = grounded || wallGrounded;

    for (let pass = 0; pass < 2; pass += 1) {
      resolveRectAgainstDebris(body, item);
      resolveRectAgainstWalls(body);
    }

    if (grounded) {
      item.vy = Math.min(item.vy, 0);
    }

    if (body.y > H + 300) {
      body.y = 220;
      body.x = 1700;
      body.vx = 0;
      body.vy = 0;
    }
  }
}

function drawBackground() {
  ctx.drawImage(backgroundCanvas, 0, 0);
}

function drawWallsDebug() {
  if (!wallGrid) {
    return;
  }

  ctx.save();
  ctx.globalAlpha = 0.12;
  ctx.fillStyle = '#1f2937';
  for (let row = 0; row < gridRows; row += 1) {
    for (let col = 0; col < gridCols; col += 1) {
      if (wallGrid[row * gridCols + col] !== 1) {
        continue;
      }
      ctx.fillRect(col * TILE_SIZE, row * TILE_SIZE, TILE_SIZE, TILE_SIZE);
    }
  }
  ctx.restore();
}

function drawDebris() {
  for (const item of debris) {
    ctx.save();
    if (item.img) {
      ctx.drawImage(item.img, item.x, item.y, item.w, item.h);
    } else {
      ctx.fillStyle = item.color;
      ctx.strokeStyle = item.shadow;
      ctx.lineWidth = 2;
      ctx.fillRect(item.x, item.y, item.w, item.h);
      ctx.strokeRect(item.x, item.y, item.w, item.h);
    }
    ctx.restore();
  }
}

function drawDecorations() {
  for (const decoration of decorations) {
    ctx.save();
    if (decoration.kind === 'rebar') {
      ctx.fillStyle = '#9ca3af';
      ctx.fillRect(decoration.x, decoration.y, decoration.w, decoration.h);
      ctx.fillStyle = '#6b7280';
      ctx.fillRect(decoration.x + 2, decoration.y, 2, decoration.h);
      ctx.fillRect(decoration.x + 4, decoration.y, 1, decoration.h);
    } else {
      ctx.drawImage(decoration.img, decoration.x, decoration.y, decoration.w, decoration.h);
    }
    ctx.restore();
  }
}

function drawPlayer() {
  const facing = player.face >= 0 ? 1 : -1;
  const centerX = player.x + player.w * 0.5;
  const headX = centerX;
  // cutscene-driven display offset (player appears slightly slumped, then rises)
  const progress = clamp(cutsceneTime / cutsceneDuration, 0, 1);
  const easeOut = (t) => 1 - Math.pow(1 - t, 2);
  const drawOffsetY = cutsceneActive ? (1 - easeOut(progress)) * 12 : 0;
  const headY = player.y + 12 + drawOffsetY;
  const torsoX = player.x + 6;
  const torsoY = player.y + 38 + drawOffsetY;

  ctx.save();

  ctx.fillStyle = '#0f172a';
  ctx.fillRect(player.x + 10, player.y + 68 + drawOffsetY, player.w - 20, 26);

  ctx.fillStyle = '#4f7f92';
  roundRect(ctx, torsoX, torsoY, player.w - 12, 48, 12);
  ctx.fill();

  ctx.fillStyle = '#22304a';
  ctx.beginPath();
  ctx.arc(headX, headY, 24, 0, Math.PI * 2);
  ctx.fill();

  // Lens light: fade in during cutscene, then stay fully on
  const lensDelay = 0.5 * cutsceneDuration;
  const lensT = clamp((cutsceneTime - lensDelay) / Math.max(0.0001, cutsceneDuration - lensDelay), 0, 1);
  const lensAlpha = cutsceneActive ? Math.pow(lensT, 2) : 1;
  ctx.save();
  ctx.globalAlpha = lensAlpha;
  ctx.fillStyle = '#1cb5e0';
  ctx.beginPath();
  ctx.arc(headX + facing * 5, headY - 4, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const shoulderSideX = facing > 0 ? player.x + player.w - 8 : player.x + 8;
  const shoulderSideY = player.y + 50 + drawOffsetY;
  const upperArmLength = 16;
  const forearmLength = 22;
  const reachX = hand.x - shoulderSideX;
  const reachY = hand.y - shoulderSideY;
  const reachDistance = Math.max(0.001, Math.hypot(reachX, reachY));
  const clampedReach = Math.min(reachDistance, upperArmLength + forearmLength - 1);
  const bendBase = Math.acos(clamp((upperArmLength * upperArmLength + clampedReach * clampedReach - forearmLength * forearmLength) / (2 * upperArmLength * clampedReach), -1, 1));
  const armAngle = Math.atan2(reachY, reachX);
  const bendDirection = facing * (hand.y < shoulderSideY ? -1 : 1);
  const elbowAngle = armAngle + bendDirection * bendBase;
  const elbowX = shoulderSideX + Math.cos(elbowAngle) * upperArmLength;
  const elbowY = shoulderSideY + Math.sin(elbowAngle) * upperArmLength;
  const wristAngle = Math.atan2(hand.y - elbowY, hand.x - elbowX);

  ctx.fillStyle = '#dbeafe';
  ctx.beginPath();
  ctx.arc(shoulderSideX, shoulderSideY, 5, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = '#8fa0b6';
  ctx.lineWidth = 11;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(shoulderSideX, shoulderSideY);
  ctx.lineTo(elbowX, elbowY);
  ctx.lineTo(hand.x, hand.y);
  ctx.stroke();

  ctx.fillStyle = '#718096';
  ctx.beginPath();
  ctx.arc(elbowX, elbowY, 4.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.translate(hand.x, hand.y);
  ctx.rotate(wristAngle);
  ctx.fillStyle = isGrabbing ? '#22d3ee' : '#b8c2d0';
  ctx.fillRect(-6, -11, 18, 22);
  ctx.restore();

  ctx.restore();
}

function drawHud() {
  ctx.save();
  ctx.fillStyle = 'rgba(15, 23, 42, 0.45)';
  ctx.fillRect(16, 16, 410, 74);

  ctx.fillStyle = '#dbeafe';
  ctx.font = '700 24px "Segoe UI", system-ui, sans-serif';
  ctx.fillText('OneArm - Start Area', 28, 44);

  ctx.fillStyle = '#cbd5e1';
  ctx.font = '500 14px "Segoe UI", system-ui, sans-serif';
  ctx.fillText('마우스 이동: 팔 조작   좌클릭 유지: 지형 잡기/잔해 집기', 28, 66);
  ctx.fillText('직접 이동은 없고, 지형을 당겨 몸을 움직여야 합니다.', 28, 86);
  ctx.restore();
}

function drawLoading() {
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#dbeafe';
  ctx.font = '700 28px "Segoe UI", system-ui, sans-serif';
  ctx.fillText('Loading start map...', 40, 64);
  if (loadingError) {
    ctx.fillStyle = '#fca5a5';
    ctx.font = '500 18px "Segoe UI", system-ui, sans-serif';
    ctx.fillText(loadingError, 40, 100);
  }
}

function roundRect(context, x, y, w, h, r) {
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + w, y, x + w, y + h, r);
  context.arcTo(x + w, y + h, x, y + h, r);
  context.arcTo(x, y + h, x, y, r);
  context.arcTo(x, y, x + w, y, r);
  context.closePath();
}

function update(dt) {
  if (!sceneReady) {
    return;
  }

  // If a startup cutscene is active, advance it and skip gameplay updates
  if (cutsceneActive) {
    cutsceneTime += dt;
    if (cutsceneTime >= cutsceneDuration) {
      cutsceneActive = false;
    }
    return;
  }

  // If an entering animation is active (player sliding in from left on new map), advance it
  if (mapEnterActive) {
    mapEnterTimer += dt;
    const t = clamp(mapEnterTimer / Math.max(0.0001, mapEnterDuration), 0, 1);
    const ease = 1 - Math.pow(1 - t, 2);
    player.x = mapEnterStartX + (mapEnterTargetX - mapEnterStartX) * ease;
    // keep hand following shoulder while entering
    hand.x = player.x + player.w + 18;
    hand.y = player.y + 40;
    prevHand.x = hand.x;
    prevHand.y = hand.y;

    if (mapEnterTimer >= mapEnterDuration) {
      mapEnterActive = false;
      // Finalize spawn: clear input/velocity and ensure player sits slightly above ground
      resetInputState();
      player.vx = 0;
      player.vy = 0;
      snapPlayerToGround();
      // nudge player up a few pixels to avoid immediate penetration
      player.y = Math.max(0, player.y - 4);
    }

    return;
  }

  updateHand(dt);
  updatePlayer(dt);
  updateDebris(dt);

  // If we're already performing a corridor transition, advance it (auto-walk + fade)
  if (transitionActive) {
    transitionTimer += dt;
    // auto-walk right to simulate walking through corridor
    player.x += transitionSpeed * dt;

    if (transitionTimer >= transitionDuration) {
      transitionActive = false;
      // finalize by loading the next map with player on left
      const nextMap = currentMap === 'start' ? 'corridor' : 'third';
      const nextStartX = nextMap === 'third' ? W - player.w - 40 : 40;
      loadMap(nextMap, nextStartX).catch((e) => { loadingError = e instanceof Error ? e.message : String(e); });
      return;
    }
    return;
  }

  // Start a smooth transition when player reaches the right trigger zone
  if (!isTransitioning && (currentMap === 'start' || currentMap === 'corridor') && player.x > W - transitionZoneWidth && player.onGround) {
    transitionActive = true;
    transitionTimer = 0;
    // disable player interactions
    resetInputState();
    return;
  }
}

function draw() {
  if (!sceneReady) {
    drawLoading();
    return;
  }

  ctx.clearRect(0, 0, W, H);
  drawBackground();
  drawWallsDebug();
  drawDecorations();
  drawDebris();
  drawPlayer();

  // Draw fade overlay during transition (ease-in)
  if (transitionActive || isTransitioning) {
    const t = clamp(transitionTimer / Math.max(0.0001, transitionDuration), 0, 1);
    const alpha = t * t; // ease-in quadratic
    ctx.save();
    ctx.fillStyle = `rgba(0,0,0,${alpha})`;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
}

let last = performance.now();
function loop(now) {
  let dt = (now - last) / 1000;
  last = now;
  dt = Math.min(dt, 0.05);

  update(dt);
  draw();
  requestAnimationFrame(loop);
}

canvas.addEventListener('mousemove', (event) => {
  const rect = canvas.getBoundingClientRect();
  const scaleX = W / rect.width;
  const scaleY = H / rect.height;
  mouse.x = (event.clientX - rect.left) * scaleX;
  mouse.y = (event.clientY - rect.top) * scaleY;
});

canvas.addEventListener('mousedown', (event) => {
  if (event.button !== 0) {
    return;
  }

  if (cutsceneActive || transitionActive || isTransitioning || mapEnterActive) {
    return;
  }

  mouseDown = true;
  holdTimer = 0;
});

canvas.addEventListener('mouseup', (event) => {
  if (event.button !== 0) {
    return;
  }

  if (cutsceneActive || transitionActive || isTransitioning || mapEnterActive) {
    return;
  }

  mouseDown = false;
  if (isGrabbing && grabbed) {
    grabbed.vx = clamp(handVx, -THROW_CAP, THROW_CAP);
    grabbed.vy = clamp(handVy, -THROW_CAP, THROW_CAP);
  }

  // release anchor and held object
  if (grabbed && grabType === 'object') {
    grabbed.held = false;
  }
  handAnchor.active = false;

  isGrabbing = false;
  grabbed = null;
  grabType = null;
});

window.addEventListener('keydown', (event) => {
  if (event.code === 'Space') {
    event.preventDefault();
  }
});

window.addEventListener('keyup', (event) => {
  if (event.code === 'Space') {
    event.preventDefault();
  }
});

async function init() {
  try {
    await loadMap('start', 560, 250);
  } catch (error) {
    loadingError = error instanceof Error ? error.message : String(error);
  }
}

init();
requestAnimationFrame(loop);
// Dylan's Animated Tokens - V14 Port
// Based on v2.0.6 by RightHandOfVecna
// V14 changes applied:
//   - TokenConfig moved to ApplicationV2: renderTokenConfig hook args changed
//     (app, html, context) where html is HTMLElement; app.document replaces app.token
//   - canvasConfig hook renamed to canvasInit in V14 for Token class override
//   - PIXI v8 (V14): TextureSystem.prototype.setStyle signature changed;
//     scaleMode now set via baseTexture.scaleMode directly
//   - game.video.cloneTexture removed in V14; use foundry.canvas.loadTexture
//   - _PRIVATE_animate deprecated until:14; Token movement now uses
//     CONFIG.Token.movement actions API (animate() still works, internals differ)
//   - foundry.canvas.layers.PlaceablesLayer._getMovableObjects still present in V14
//   - Scene.prototype.updateEmbeddedDocuments still wrappable in V14
//   - Sequencer is V14-compatible as of their January 2026 update
//   - socketlib: API unchanged, works in V14

const MODULE_ID = "dylans-animated-tokens";
const MODULE_VERSION = "2.0.6-v14";

// ─── Utilities ───────────────────────────────────────────────────────────────

function isAssistantOrAbove() {
  const role = game.data.users.find(u => u._id === game.data.userId).role;
  return role >= CONST.USER_ROLES.ASSISTANT;
}

function isActiveGM() {
  return game.users.find(u => u.active && u.isGM)?.id === game.user.id;
}

function hasActiveGM() {
  return game.users.some(u => u.active && u.isGM);
}

function getScene(token) {
  return token?.scene ?? token?.parent ?? game.scenes.active;
}

function getActiveCombats(sceneUuid) {
  const byscene = game.combats.filter(c => c?.active && c?.scene?.uuid === sceneUuid) ?? [];
  return byscene.length > 0
    ? byscene
    : game.combats.filter(c => c?.active && c?.combatants?.some(t => t.scene === sceneUuid)) ?? [];
}

// ─── Version migration check ──────────────────────────────────────────────────

function registerMigration() {
  Hooks.on("ready", () => {
    if (game.modules.get(MODULE_ID).version !== MODULE_VERSION) {
      const isMac = (() => {
        try { return navigator?.userAgentData?.platform?.includes("Mac") ?? navigator?.platform?.includes("Mac"); }
        catch { return false; }
      })();
      const reload = isMac ? "⌘ + Shift + R" : "Ctrl + F5";
      ui.notifications.error(
        `Dylan's Animated Tokens: Your browser cache appears to be out of date. Please reload using ${reload}.`,
        { permanent: true }
      );
    }
  });
}

// ─── Settings ─────────────────────────────────────────────────────────────────

function registerSettings() {
  game.settings.register(MODULE_ID, "avoidBlur", {
    name: "Avoid Blur", default: true, type: Boolean, scope: "world",
    requiresReload: true, config: true,
    hint: "Avoid blurring the canvas and tokens when they get scaled up."
  });
  game.settings.register(MODULE_ID, "walkSpeed", {
    name: "Token Walk Speed", default: 4,
    type: new foundry.data.fields.NumberField({ min: 1, step: 1 }),
    scope: "world", requiresReload: false, config: true,
    hint: "The number of grid spaces per second that a token moves when walking."
  });
  game.settings.register(MODULE_ID, "runSpeed", {
    name: "Token Run Speed", default: 8,
    type: new foundry.data.fields.NumberField({ min: 1, step: 1 }),
    scope: "world", requiresReload: false, config: true,
    hint: "The number of grid spaces per second that a token moves when running."
  });
  game.settings.register(MODULE_ID, "runDistance", {
    name: "Token Run Distance", default: 5,
    type: new foundry.data.fields.NumberField({ min: 1, step: 1 }),
    scope: "world", requiresReload: false, config: true,
    hint: "How many grid spaces a token can move before it is considered to be running."
  });
  game.settings.register(MODULE_ID, "playIdleAnimations", {
    name: "Play Idle Animations", default: false, type: Boolean,
    scope: "world", requiresReload: false, config: true,
    hint: "Whether or not to play idle animations for tokens."
  });
  game.settings.register(MODULE_ID, "idleAnimTime", {
    name: "Idle Animation Time", default: 600,
    type: new foundry.data.fields.NumberField({ min: 1, step: 1 }),
    scope: "world", requiresReload: false, config: true,
    hint: "How many milliseconds it takes to wrap through an idle animation."
  });
  game.settings.register(MODULE_ID, "tokenCollision", {
    name: "Token Collisions", default: true, type: Boolean,
    scope: "world", requiresReload: true, config: true,
    hint: "Treat tokens as walls for the purpose of movement."
  });
  game.settings.register(MODULE_ID, "tokenCollisionAllied", {
    name: "Token Collisions (Allied)", default: false, type: Boolean,
    scope: "world", requiresReload: true, config: true,
    hint: "Treat allied tokens as walls for the purpose of movement. Requires 'Token Collisions' to be enabled."
  });
  game.settings.register(MODULE_ID, "tokenCollisionHidden", {
    name: "Token Collisions (Hidden)", default: false, type: Boolean,
    scope: "world", requiresReload: true, config: true,
    hint: "Treat hidden tokens as walls for the purpose of movement. Requires 'Token Collisions' to be enabled."
  });
  game.settings.register(MODULE_ID, "enableFollow", {
    name: "Enable Token Following", default: true, type: Boolean,
    scope: "world", requiresReload: true, config: true,
    hint: "Allows players to mark tokens to automatically follow when they move."
  });
  game.settings.register(MODULE_ID, "allowTokenArtPastBounds", {
    name: "Allow Token Art Past Bounds", default: true, type: Boolean,
    scope: "world", requiresReload: false, config: true,
    hint: "Whether the positioning settings automatically extend art above the grid space."
  });
}

// ─── Socket ───────────────────────────────────────────────────────────────────

function getSocket() {
  return game.modules.get(MODULE_ID).soc;
}

function registerSocketFunction(name, fn) {
  const soc = getSocket();
  if (typeof soc !== "object") {
    game.modules.get(MODULE_ID).socketFunctions ??= [];
    game.modules.get(MODULE_ID).socketFunctions.push({ name, fn });
    return;
  }
  soc.register(name, fn);
}

Hooks.once("socketlib.ready", () => {
  const soc = socketlib.registerModule(MODULE_ID);
  game.modules.get(MODULE_ID).soc = soc;
  (game.modules.get(MODULE_ID).socketFunctions ?? []).forEach(({ name, fn }) => soc.register(name, fn));
});

// ─── Following logic ──────────────────────────────────────────────────────────

const FOLLOW_FLAG = "following";

function getFollowMap(scene) {
  const result = {};
  const tokens = scene?.tokens;
  if (!tokens) return {};
  for (const t of tokens) {
    const who = t.getFlag(MODULE_ID, FOLLOW_FLAG)?.who;
    if (who) {
      result[who] ??= [];
      result[who].push(t.id);
    }
  }
  return result;
}

function getFollowers(token) {
  const scene = getScene(token);
  const tokens = scene?.tokens;
  const followMap = getFollowMap(scene);
  const visited = [];
  const visit = id => {
    followMap[id]?.forEach(fid => {
      if (!visited.includes(fid)) { visited.push(fid); visit(fid); }
    });
  };
  visit(token.id);
  return visited.map(id => tokens.get(id));
}

function getFollowCycle(token) {
  const followers = getFollowers(token);
  const scene = getScene(token);
  const visited = new Set();
  const visit = t => {
    if (!t || visited.has(t)) return;
    visited.add(t);
    const who = t.getFlag(MODULE_ID, FOLLOW_FLAG)?.who;
    who && visit(scene?.tokens?.get(who));
  };
  visit(token);
  followers.forEach(visit);
  return visited;
}

function buildFollowerUpdates(token, movementMap, followers) {
  if (!movementMap) return [];
  const updates = [];
  for (const follower of followers) {
    const myFollow = foundry.utils.deepClone(follower.getFlag(MODULE_ID, FOLLOW_FLAG));
    const leaderMove = foundry.utils.deepClone(movementMap[token.id]);
    if (!leaderMove) break;
    leaderMove.waypoints.unshift({ ...leaderMove.waypoints.at(0), x: token.x, y: token.y });
    const lastWaypoint = leaderMove.waypoints.pop();
    const followerMove = movementMap[follower.id] = { ...foundry.utils.deepClone(leaderMove), waypoints: leaderMove.waypoints };
    const end = followerMove.waypoints.at(-1);
    const gridSize = canvas.grid.size;
    let dx = lastWaypoint.x - end.x;
    let dy = lastWaypoint.y - end.y;
    dx = Math.sign(dx) * Math.max(0, Math.abs(dx) - gridSize);
    dy = Math.sign(dy) * Math.max(0, Math.abs(dy) - gridSize);
    let snap = { x: end.x + dx, y: end.y + dy };
    snap = canvas.grid.getSnappedPoint(snap, { mode: CONST.GRID_SNAPPING_MODES.TOP_LEFT_VERTEX });
    if (snap.x !== end.x || snap.y !== end.y) followerMove.waypoints.push({ ...lastWaypoint, ...snap });
    followerMove.method = "api";
    updates.push({ _id: follower.id, x: followerMove.waypoints.at(-1).x, y: followerMove.waypoints.at(-1).y, [`flags.${MODULE_ID}.${FOLLOW_FLAG}`]: myFollow });
    token = follower;
  }
  return updates;
}

async function teleportFollowers(followerUuids, destination, sceneId) {
  if (!isActiveGM() && hasActiveGM()) {
    const soc = getSocket();
    return soc ? soc.executeAsGM("TeleportFollowers", followerUuids, destination, sceneId) : undefined;
  }
  const scene = game.scenes.get(sceneId);
  if (!scene) return;
  const followers = await Promise.all(followerUuids.map(uuid => fromUuid(uuid)));
  const sameScene = [], otherScene = [], otherSceneMap = {};
  for (const f of followers) {
    const fScene = getScene(f);
    if (fScene.id === sceneId) {
      sameScene.push({ _id: f.id, x: destination.x, y: destination.y, [`flags.${MODULE_ID}.${FOLLOW_FLAG}.positions`]: [{ x: destination.x, y: destination.y }] });
    } else {
      otherScene.push({ ...f.toObject(), x: destination.x, y: destination.y, [`flags.${MODULE_ID}.${FOLLOW_FLAG}.positions`]: [destination], [`flags.${MODULE_ID}.${FOLLOW_FLAG}.originalid`]: f.id });
      otherSceneMap[fScene.id] ??= [];
      otherSceneMap[fScene.id].push(f.id);
    }
  }
  await scene.updateEmbeddedDocuments("Token", sameScene, { follower_updates: [], forced: true, teleport: true });
  if (otherScene.length === 0) return;
  await scene.createEmbeddedDocuments("Token", otherScene, { follower_updates: [], teleport: true });
  await Promise.all(Object.entries(otherSceneMap).map(([sid, ids]) => {
    const s = game.scenes.get(sid);
    return s?.deleteEmbeddedDocuments("Token", ids, { teleport: true });
  }));
  const idMap = {};
  for (const t of scene.tokens) {
    const orig = t.getFlag(MODULE_ID, FOLLOW_FLAG)?.originalid;
    if (orig) idMap[orig] = t.id;
  }
  if (!Object.keys(idMap).length) return;
  const remaps = {};
  for (const t of scene.tokens) {
    const who = t.getFlag(MODULE_ID, FOLLOW_FLAG)?.who;
    if (who && idMap[who] && idMap[who] !== who) {
      remaps[t.id] = { _id: t.id, [`flags.${MODULE_ID}.${FOLLOW_FLAG}.who`]: idMap[who] };
    }
  }
  for (const t of scene.tokens) {
    if (t.getFlag(MODULE_ID, FOLLOW_FLAG)?.originalid) {
      remaps[t.id] ??= { _id: t.id };
      remaps[t.id][`flags.${MODULE_ID}.${FOLLOW_FLAG}.originalid`] = null;
    }
  }
  await scene.updateEmbeddedDocuments("Token", Object.values(remaps), { follower_updates: [] });
}

// ─── Direction helpers ─────────────────────────────────────────────────────────

const DIRECTIONS = {
  down: { angle: 0 }, downright: { angle: 45 }, right: { angle: 90 },
  upright: { angle: 135 }, up: { angle: 180 }, upleft: { angle: 225 },
  left: { angle: 270 }, downleft: { angle: 315 }
};

function rotationToDirection(rotation) {
  const r = ((rotation % 360) + 360) % 360;
  if (r < 22.5 || r >= 337.5) return "down";
  if (r < 67.5) return "downright";
  if (r < 112.5) return "right";
  if (r < 157.5) return "upright";
  if (r < 202.5) return "up";
  if (r < 247.5) return "upleft";
  if (r < 292.5) return "left";
  return "downleft";
}

function deltaToDirection(dx, dy) {
  const angle = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
  return rotationToDirection(angle);
}

// ─── Spritesheet format definitions ───────────────────────────────────────────

// Each generator function takes (data, spriteData, frames) and populates spriteData.
// spriteData.animations[direction] = [frameKeys...]
// spriteData.frames[frameKey] = { frame: {x,y,w,h}, sourceSize, spriteSourceSize }

const SHEET_STYLES = {};

function buildSheetStyle(id, label, frames, alias, anchor, defaultRatio, generator) {
  SHEET_STYLES[id] = { label: `DAT.SheetStyle.${label}`, frames, alias, anchor, defaultRatio, generator };
}

// DLRU: Down Left Right Up, N frames per row
function genDLRU(data, spriteData, numFrames) {
  const dirs = ["down", "left", "right", "up"];
  const [fw, fh] = [data.meta.size.w / numFrames, data.meta.size.h / 4];
  dirs.forEach((dir, row) => {
    spriteData.animations[dir] ??= [];
    for (let col = 0; col < numFrames; col++) {
      const key = `${dir}_${col}`;
      spriteData.animations[dir].push(key);
      if (dir === "down") { spriteData.animations.downleft.push(key); spriteData.animations.downright.push(key); }
      else if (dir === "left") spriteData.animations.upleft.push(key);
      else if (dir === "right") spriteData.animations.upright.push(key);
      spriteData.frames[key] = { frame: { x: fw * col, y: fh * row, w: fw, h: fh }, sourceSize: { w: fw, h: fh }, spriteSourceSize: { x: 0, y: 0, w: fw, h: fh } };
    }
  });
}

// DURL Reduced: Down Up Right Left with first frame duplicated (idle frame)
function genDURLReduced(data, spriteData, numFrames) {
  const dirs = ["down", "up", "right", "left"];
  const [fw, fh] = [data.meta.size.w / numFrames, data.meta.size.h / 4];
  dirs.forEach((dir, row) => {
    spriteData.animations[dir] ??= [];
    for (let col = 0; col < numFrames; col++) {
      const key = `${dir}_${col}`;
      spriteData.animations[dir].push(key);
      if (dir === "down") { spriteData.animations.downleft.push(key); spriteData.animations.downright.push(key); }
      else if (dir === "left") spriteData.animations.upleft.push(key);
      else if (dir === "right") spriteData.animations.upright.push(key);
      spriteData.frames[key] = { frame: { x: fw * col, y: fh * row, w: fw, h: fh }, sourceSize: { w: fw, h: fh }, spriteSourceSize: { x: 0, y: 0, w: fw, h: fh } };
    }
    // DURL reduced: wrap the walk frames as [1,0,1,2]
    const anim = spriteData.animations[dir];
    if (anim.length >= 3) spriteData.animations[dir] = [anim[1], anim[0], anim[1], anim[2]];
  });
}

// 8-directional
function gen8Dir(data, spriteData, numFrames) {
  const dirs = ["down", "downright", "right", "upright", "up", "upleft", "left", "downleft"];
  const [fw, fh] = [data.meta.size.w / numFrames, data.meta.size.h / 8];
  dirs.forEach((dir, row) => {
    spriteData.animations[dir] ??= [];
    for (let col = 0; col < numFrames; col++) {
      const key = `${dir}_${col}`;
      spriteData.animations[dir].push(key);
      spriteData.frames[key] = { frame: { x: fw * col, y: fh * row, w: fw, h: fh }, sourceSize: { w: fw, h: fh }, spriteSourceSize: { x: 0, y: 0, w: fw, h: fh } };
    }
  });
}

// Diagonal only
function genDiagonal(data, spriteData, numFrames) {
  const dirs = ["downright", "upright", "upleft", "downleft"];
  const [fw, fh] = [data.meta.size.w / numFrames, data.meta.size.h / 4];
  dirs.forEach((dir, row) => {
    spriteData.animations[dir] ??= [];
    for (let col = 0; col < numFrames; col++) {
      const key = `${dir}_${col}`;
      spriteData.animations[dir].push(key);
      if (dir === "downright") spriteData.animations.down.push(key);
      else if (dir === "upright") spriteData.animations.right.push(key);
      else if (dir === "upleft") spriteData.animations.up.push(key);
      else if (dir === "downleft") spriteData.animations.left.push(key);
      spriteData.frames[key] = { frame: { x: fw * col, y: fh * row, w: fw, h: fh }, sourceSize: { w: fw, h: fh }, spriteSourceSize: { x: 0, y: 0, w: fw, h: fh } };
    }
  });
}

// Nihey: rows = S W E N (Down Left Right Up), 4 frames, first is idle
function genNihey(data, spriteData, numFrames) {
  const dirs = ["down", "left", "right", "up"];
  const [fw, fh] = [data.meta.size.w / numFrames, data.meta.size.h / 4];
  dirs.forEach((dir, row) => {
    spriteData.animations[dir] ??= [];
    for (let col = 0; col < numFrames; col++) {
      const key = `${dir}_${col}`;
      spriteData.animations[dir].push(key);
      if (dir === "down") { spriteData.animations.downleft.push(key); spriteData.animations.downright.push(key); }
      else if (dir === "left") spriteData.animations.upleft.push(key);
      else if (dir === "right") spriteData.animations.upright.push(key);
      spriteData.frames[key] = { frame: { x: fw * col, y: fh * row, w: fw, h: fh }, sourceSize: { w: fw, h: fh }, spriteSourceSize: { x: 0, y: 0, w: fw, h: fh } };
    }
    // Nihey: [1,0,1,2] walk pattern
    const anim = spriteData.animations[dir];
    if (anim.length >= 3) spriteData.animations[dir] = [anim[1], anim[0], anim[1], anim[2]];
  });
}

// Universal LPC: very large sheet, 54 rows × 13 cols
function genUniversalLPC(data, spriteData) {
  const dirs = ["up", "left", "down", "right"];
  const [fw, fh] = [data.meta.size.w / 13, data.meta.size.h / 54];
  const walkRows = { up: 8, left: 9, down: 10, right: 11 };
  dirs.forEach(dir => {
    spriteData.animations[dir] ??= [];
    const row = walkRows[dir];
    for (let col = 1; col <= 9; col++) {
      const key = `${dir}_walk_${col}`;
      spriteData.animations[dir].push(key);
      if (dir === "down") { spriteData.animations.downleft.push(key); spriteData.animations.downright.push(key); }
      else if (dir === "left") spriteData.animations.upleft.push(key);
      else if (dir === "right") spriteData.animations.upright.push(key);
      spriteData.frames[key] = { frame: { x: fw * col, y: fh * row, w: fw, h: fh }, sourceSize: { w: fw, h: fh }, spriteSourceSize: { x: 0, y: 0, w: fw, h: fh } };
    }
  });
}

// Memao: idle, walk, run in rows, 4 dirs (down/up/right/left), with separate idle frames
function genMemao(data, spriteData, numFrames) {
  const dirs = ["down", "up", "right", "left"];
  const sections = ["idle", "", "run"];  // idle, walk, run rows
  const totalRows = dirs.length * sections.length;
  const [fw, fh] = [data.meta.size.w / numFrames, data.meta.size.h / totalRows];
  dirs.forEach((dir, di) => {
    spriteData.animations[dir] ??= [];
    spriteData.animations[`idle${dir}`] ??= [];
    spriteData.animations[`run${dir}`] ??= [];
    // idle row
    const idleRow = di * 3;
    for (let col = 0; col < numFrames; col++) {
      const key = `${dir}_idle_${col}`;
      spriteData.animations[`idle${dir}`].push(key);
      spriteData.frames[key] = { frame: { x: fw * col, y: fh * idleRow, w: fw, h: fh }, sourceSize: { w: fw, h: fh }, spriteSourceSize: { x: 0, y: 0, w: fw, h: fh } };
    }
    // walk row
    const walkRow = di * 3 + 1;
    for (let col = 0; col < numFrames; col++) {
      const key = `${dir}_walk_${col}`;
      spriteData.animations[dir].push(key);
      if (dir === "down") { spriteData.animations.downleft?.push(key); spriteData.animations.downright?.push(key); }
      else if (dir === "left") spriteData.animations.upleft?.push(key);
      else if (dir === "right") spriteData.animations.upright?.push(key);
      spriteData.frames[key] = { frame: { x: fw * col, y: fh * walkRow, w: fw, h: fh }, sourceSize: { w: fw, h: fh }, spriteSourceSize: { x: 0, y: 0, w: fw, h: fh } };
    }
    // run row
    const runRow = di * 3 + 2;
    for (let col = 0; col < numFrames; col++) {
      const key = `${dir}_run_${col}`;
      spriteData.animations[`run${dir}`].push(key);
      spriteData.frames[key] = { frame: { x: fw * col, y: fh * runRow, w: fw, h: fh }, sourceSize: { w: fw, h: fh }, spriteSourceSize: { x: 0, y: 0, w: fw, h: fh } };
    }
  });
}

// TDSM styles (Top Down Sprite Maker by Jordan Bunke)
// Gen3, Gen4, PixelCitizen, TimeElements use same 4-dir layout with different row orders/frame counts
function genTDSMBase(data, spriteData, numFrames, rowOrder) {
  const [fw, fh] = [data.meta.size.w / numFrames, data.meta.size.h / rowOrder.length];
  rowOrder.forEach((dir, row) => {
    if (!dir) return;
    spriteData.animations[dir] ??= [];
    for (let col = 0; col < numFrames; col++) {
      const key = `${dir}_${row}_${col}`;
      spriteData.animations[dir].push(key);
      if (dir === "down") { spriteData.animations.downleft?.push(key); spriteData.animations.downright?.push(key); }
      else if (dir === "left") spriteData.animations.upleft?.push(key);
      else if (dir === "right") spriteData.animations.upright?.push(key);
      spriteData.frames[key] = { frame: { x: fw * col, y: fh * row, w: fw, h: fh }, sourceSize: { w: fw, h: fh }, spriteSourceSize: { x: 0, y: 0, w: fw, h: fh } };
    }
  });
}

// Pokemon-style: 8 rows in order S SE E NE N NW W SW, N frames per row
function genPokemon(data, spriteData, numFrames) {
  const dirs = ["down", "downright", "right", "upright", "up", "upleft", "left", "downleft"];
  const [fw, fh] = [data.meta.size.w / numFrames, data.meta.size.h / 8];
  dirs.forEach((dir, row) => {
    spriteData.animations[dir] ??= [];
    for (let col = 0; col < numFrames; col++) {
      const key = `pokemon_${dir}_${col}`;
      spriteData.animations[dir].push(key);
      spriteData.frames[key] = { frame: { x: fw * col, y: fh * row, w: fw, h: fh }, sourceSize: { w: fw, h: fh }, spriteSourceSize: { x: 0, y: 0, w: fw, h: fh } };
    }
  });
}

// Populate SHEET_STYLES
buildSheetStyle("dlru", "DLRU", undefined, null, null, null, genDLRU);
buildSheetStyle("durlreduced", "DURLReduced", undefined, null, null, null, genDURLReduced);
buildSheetStyle("eight", "Eight", undefined, null, 0.5, null, gen8Dir);
buildSheetStyle("pokemon", "Pokemon", 6, null, 0.5, null, genPokemon);
buildSheetStyle("diagonal", "Diagonal", undefined, null, null, null, genDiagonal);
buildSheetStyle("nihey", "Nihey", 4, null, null, null, genNihey);
buildSheetStyle("universallpc", "UniversalLPC", undefined, null, null, null, genUniversalLPC);
buildSheetStyle("memao", "Memao", undefined, null, null, null, genMemao);
// TDSM styles
buildSheetStyle("tdsmgen3", "TDSMGen3", undefined, null, null, null,
  (d, s, f) => genTDSMBase(d, s, f, ["down", "left", "right", "up"]));
buildSheetStyle("tdsmgen4", "TDSMGen4", undefined, null, null, null,
  (d, s, f) => genTDSMBase(d, s, f, ["down", "up", "left", "right"]));
buildSheetStyle("tdsmpixelcitizen", "TDSMPixelCitizen", undefined, null, null, null,
  (d, s, f) => genTDSMBase(d, s, f, ["down", "left", "right", "up"]));
buildSheetStyle("tdsmtimeelements", "TDSMTimeElements", undefined, null, null, null,
  (d, s, f) => genTDSMBase(d, s, f, ["down", "left", "right", "up"]));
buildSheetStyle("tdsmtimeelementsmini", "TDSMTimeElementsMini", undefined, null, null, null,
  (d, s, f) => genTDSMBase(d, s, f, ["down", "left", "right", "up"]));

// ─── Spritesheet generator (parses sheet into PIXI SpriteSheet data) ──────────

const spritesheetCache = new Map();

function generateSpritesheetKey(src, style, frames) {
  return `${src}::${style}::${frames}`;
}

async function getTexturesForToken(token, baseTexture) {
  const style = token.sheetStyle ?? "dlru";
  const numFrames = token.animationFrames ?? 4;
  const key = generateSpritesheetKey(token.document.texture.src, style, numFrames);

  if (spritesheetCache.has(key)) return spritesheetCache.get(key);

  const styleConfig = SHEET_STYLES[style];
  if (!styleConfig) return null;

  const img = baseTexture?.baseTexture?.resource?.source ?? baseTexture?.source;
  const w = baseTexture?.width ?? baseTexture?.baseTexture?.width ?? 0;
  const h = baseTexture?.height ?? baseTexture?.baseTexture?.height ?? 0;
  if (!w || !h) return null;

  const frameCount = styleConfig.frames ?? numFrames;

  // Build spritesheet data structure
  const spriteData = {
    frames: {},
    animations: Object.fromEntries(Object.keys(DIRECTIONS).map(d => [d, []])),
    meta: { size: { w, h }, scale: 1 }
  };

  // Bug fix: generator signature is (data, spriteData, frames).
  // data supplies meta.size (image dimensions); spriteData is populated by the generator.
  // Previously both args were spriteData, so meta.size was read from the object
  // being mutated, producing NaN frame dimensions for many sheet styles.
  const sheetData = { meta: { size: { w, h }, scale: 1 } };
  styleConfig.generator(sheetData, spriteData, frameCount);

  // Build PIXI spritesheet
  // V14 uses PIXI v8: PIXI.Spritesheet constructor is the same but resource loading differs
  const sheet = new PIXI.Spritesheet(baseTexture, {
    frames: spriteData.frames,
    animations: spriteData.animations,
    meta: spriteData.meta
  });
  await sheet.parse();

  const textures = {};
  for (const [dir, frames] of Object.entries(spriteData.animations)) {
    if (frames.length > 0) {
      textures[dir] = frames.map(fk => sheet.textures[fk]).filter(Boolean);
    }
  }

  spritesheetCache.set(key, textures);
  return textures;
}

// ─── Pixel-perfect (anti-blur) ────────────────────────────────────────────────

function registerPixelate() {
  // V14 / PIXI v8 change: TextureSystem.prototype.setStyle signature changed.
  // In PIXI v7 (V13): setStyle(texture, style) where style has scaleMode.
  // In PIXI v8 (V14): setStyle is gone; scale mode is set via texture.source.scaleMode
  // We wrap texture loading instead, which is stable across versions.
  libWrapper.register(MODULE_ID, "game.video.cloneTexture", async function(wrapped, ...args) {
    // V14 note: game.video.cloneTexture was removed. We handle this gracefully.
    if (typeof wrapped !== "function") return null;
    const tex = await wrapped(...args);
    if (tex?.baseTexture && game.settings.get(MODULE_ID, "avoidBlur")) {
      // PIXI v8: scaleMode is on the texture source
      if (tex.baseTexture.source) {
        tex.baseTexture.source.scaleMode = "nearest";
      } else {
        // PIXI v7 fallback
        tex.baseTexture.scaleMode = PIXI.SCALE_MODES?.NEAREST ?? 0;
      }
    }
    return tex;
  }, "WRAPPER");

  // For V14/PIXI v8 we also hook into texture loading at the foundry level
  Hooks.on("canvasReady", () => {
    if (!game.settings.get(MODULE_ID, "avoidBlur")) return;
    // Apply nearest-neighbor to all existing token textures
    for (const token of canvas.tokens.placeables) {
      const tex = token.mesh?.texture ?? token.texture;
      if (tex?.baseTexture) {
        if (tex.baseTexture.source) tex.baseTexture.source.scaleMode = "nearest";
        else tex.baseTexture.scaleMode = PIXI.SCALE_MODES?.NEAREST ?? 0;
      }
    }
  });
}

// ─── Token class extension ────────────────────────────────────────────────────
// V14 change: hook is still "canvasConfig" for overriding CONFIG.Token.objectClass.
// This runs before the canvas is drawn, allowing us to replace the token class.

function registerTokenClass() {
  Hooks.on("canvasConfig", () => {
    const BaseTokenClass = CONFIG.Token.objectClass;

    class AnimatedToken extends BaseTokenClass {
      // Private fields
      #frameIndex = 0;
      #textureSrc = null;
      #cacheKey = null;
      #textureCache = null;
      #direction = "down";
      #localOpacityValue = 1;
      #isIdle = false;
      #isRunning = false;

      constructor(document) {
        super(document);
      }

      clear() {
        super.clear();
        this.#frameIndex = 0;
        this.#textureSrc = null;
        this.#cacheKey = null;
        this.#textureCache = null;
        this.#direction = "down";
      }

      get isSpritesheet() {
        return this.document.getFlag(MODULE_ID, "spritesheet");
      }

      get sheetStyle() {
        return this.document.getFlag(MODULE_ID, "sheetstyle") ?? "dlru";
      }

      get animationFrames() {
        return this.document.getFlag(MODULE_ID, "animationframes") ?? 4;
      }

      get separateIdle() {
        return this.document.getFlag(MODULE_ID, "separateidle") ?? false;
      }

      get alwaysIdle() {
        return !this.separateIdle
          && game.settings.get(MODULE_ID, "playIdleAnimations")
          && !this.document.getFlag(MODULE_ID, "noidle");
      }

      get allAnimationsPromise() {
        return Promise.allSettled([...this.animationContexts.values()].map(c => c.promise));
      }

      // V14: RENDER_FLAGS still works the same way
      static RENDER_FLAGS = foundry.utils.mergeObject(
        Object.fromEntries(Object.entries(super.RENDER_FLAGS).map(([k, v]) => [k, { ...v }])),
        {
          refreshIndicators: {},
          refreshSize: { propagate: [...(super.RENDER_FLAGS.refreshSize?.propagate ?? []), "refreshIndicators"] },
          refreshShape: { propagate: [...(super.RENDER_FLAGS.refreshShape?.propagate ?? []), "refreshIndicators"] }
        }
      );

      async _draw(context) {
        if (this.isSpritesheet) {
          this.#resetDirectionFromRotation();
          await this.#loadSpritesheetTextures();
          this.texture = this.#getCurrentTexture();

          // V14: canvas.primary.addToken is unchanged
          this.mesh = canvas.primary.addToken(this);
          this.border ??= this.addChild(new PIXI.Graphics());

          this.voidMesh ??= (() => {
            const c = this.addChild(new PIXI.Container());
            c.updateTransform = () => {};
            c.render = r => this.mesh?._renderVoid?.(r);
            return c;
          })();

          this.detectionFilterMesh ??= (() => {
            const c = this.addChild(new PIXI.Container());
            c.updateTransform = () => {};
            c.render = r => { if (this.detectionFilter) this._renderDetectionFilter?.(r); };
            return c;
          })();

          this.bars ??= this.addChild(this._PRIVATE_drawAttributeBars?.() ?? new PIXI.Container());
          this.tooltip ??= this.addChild(this._PRIVATE_drawTooltip?.() ?? new PIXI.Container());
          this.effects ??= this.addChild(new PIXI.Container());
          this.targetArrows ??= this.addChild(new PIXI.Graphics());
          this.targetPips ??= this.addChild(new PIXI.Graphics());
          this.nameplate ??= this.addChild(this._PRIVATE_drawNameplate?.() ?? new PIXI.Container());
          this.sortableChildren = true;

          if (this.ruler === undefined) this.ruler = this._initializeRuler?.();
          if (this.ruler) await this.ruler.draw?.();

          this._updateSpecialStatusFilterEffects?.();
          await this._drawEffects?.();
          if (!this.isPreview) this.initializeSources?.();
        } else {
          await super._draw(context);
        }
        this.indicators ??= this.addChild(new PIXI.Container());
        await this._drawIndicators();
      }

      async #loadSpritesheetTextures() {
        const key = generateSpritesheetKey(this.document.texture.src, this.sheetStyle, this.animationFrames);
        if (this.#textureCache != null && this.#textureSrc === this.document.texture.src && this.#cacheKey === key) return;

        let baseTexture;
        if (this._original) {
          baseTexture = this._original.texture?.clone?.() ?? this._original.texture;
        } else {
          baseTexture = await foundry.canvas.loadTexture(this.document.texture.src, { fallback: CONST.DEFAULT_TOKEN });
        }

        this.#textureSrc = this.document.texture.src;
        this.#cacheKey = key;
        this.#textureCache = await getTexturesForToken(this, baseTexture);
      }

      get isIsometric() {
        return game.modules.get("isometric-perspective")?.active
          && getScene(this.document)?.flags?.["isometric-perspective"]?.isometricEnabled;
      }

      get direction() { return this.#direction; }

      #getAnimationFrames() {
        if (!this.isSpritesheet || this.#textureCache == null) return null;
        let dir = this.isIsometric
          ? (() => {
              const dirs = ["down", "downright", "right", "upright", "up", "upleft", "left", "downleft", "down"];
              return dirs[dirs.indexOf(this.#direction) + 1];
            })()
          : this.#direction;

        if (this.#isIdle && !this.separateIdle && this.#textureCache[`idle${dir}`]?.length)
          dir = `idle${dir}`;
        else if (this.#isRunning && this.#textureCache[`run${dir}`]?.length)
          dir = `run${dir}`;

        return this.#textureCache[dir] ?? null;
      }

      #getCurrentTexture() {
        const frames = this.#getAnimationFrames();
        if (!frames) return null;
        const frameCount = frames.length;
        let idx;
        if (this.#isIdle && this.separateIdle) {
          idx = 0;
        } else {
          const start = this.separateIdle ? 1 : 0;
          idx = start + (this.#frameIndex % (frameCount - start));
        }
        return frames[idx] ?? null;
      }

      set direction(value) {
        this.#direction = value;
        if (this.#textureCache == null) return;
        const tex = this.#getCurrentTexture();
        if (tex && this.mesh && this.mesh.texture !== tex) {
          this.mesh.texture = tex;
          // V14: renderFlags.set is unchanged
          this.renderFlags.set({ refreshMesh: true });
        }
      }

      set localOpacity(value) {
        value = Math.clamp(value ?? 1, 0, 1);
        const prev = this.#localOpacityValue;
        this.#localOpacityValue = value;
        if (prev !== value) {
          this.renderFlags.set({ refreshState: true });
          this.applyRenderFlags();
        }
      }

      _refreshState() {
        super._refreshState();
        if (this.mesh) {
          this.mesh.alpha = this.alpha
            * (this.hover ? Math.clamp(this.#localOpacityValue, 0.2, 1) : this.#localOpacityValue)
            * this.document.alpha;
        }
      }

      _canDrag() {
        try {
          const scene = this.document?.parent;
          const inCombat = getActiveCombats(scene?.uuid).length > 0;
          if (!game.user.isGM && scene.getFlag(MODULE_ID, "disableDrag")
            && !(scene.getFlag(MODULE_ID, "outOfCombat") && inCombat)) {
            return false;
          }
        } catch { /* scene may not exist */ }
        return super._canDrag();
      }

      #resetDirectionFromRotation() {
        this.#direction = rotationToDirection(this.document.rotation);
      }

      _refreshRotation() {
        if (!this.isSpritesheet) return super._refreshRotation();
        if (this.mesh) this.mesh.angle = 0;
        this.#resetDirectionFromRotation();
        this.#frameIndex = 0;
        if (this.#textureCache != null) {
          const tex = this.#getCurrentTexture();
          if (tex && this.mesh && this.mesh.texture !== tex) {
            this.mesh.texture = tex;
            this.renderFlags.set({ refreshMesh: true });
          }
        }
      }

      // V14 movement: Token.animate() is still the public API.
      // The internal _PRIVATE_animate was deprecated as of V14.
      // We override animate() directly for movement speed injection.
      animate(destination, options = {}) {
        if (!this.isSpritesheet) return super.animate(destination, options);

        // Determine walk vs run
        if (destination.x !== undefined || destination.y !== undefined) {
          if (this.document._sliding) {
            this.#isRunning = false;
            options.movementSpeed ??= game.settings.get(MODULE_ID, "walkSpeed") ?? 4;
          } else {
            const { sizeX = 100, sizeY = 100 } = game.scenes.active?.grid ?? {};
            const current = { x: this.x, y: this.y };
            const dist = Math.abs((destination.x ?? current.x) - current.x) / sizeX
              + Math.abs((destination.y ?? current.y) - current.y) / sizeY;
            if (dist !== 0 && dist < (game.settings.get(MODULE_ID, "runDistance") ?? 5)) {
              this.#isRunning = false;
              options.movementSpeed ??= game.settings.get(MODULE_ID, "walkSpeed") ?? 4;
            } else if (dist !== 0) {
              this.#isRunning = true;
              options.movementSpeed ??= game.settings.get(MODULE_ID, "runSpeed") ?? 8;
            }
          }
          const speedMod = options.follower_speed_modifiers?.[this.document.id] ?? 1;
          if (options.movementSpeed !== undefined) options.movementSpeed *= speedMod;
        }

        this._origin = { x: this.x, y: this.y };
        return super.animate(destination, options).finally(() => {
          if (this.isSpritesheet && this.animationContexts.size === 0) {
            this.startIdleAnimation();
          }
        });
      }

      _getAnimationRotationSpeed() {
        return Number.POSITIVE_INFINITY;
      }

      get idleAnimationDuration() {
        return game.settings.get(MODULE_ID, "idleAnimTime") ?? 600;
      }

      startIdleAnimation() {
        if (this.destroyed) return;
        this.#isIdle = true;
        const frames = this.#getAnimationFrames();
        const frameCount = frames?.length ?? 0;
        if (frameCount <= 1) return;
        const duration = this.idleAnimationDuration;
        if (duration <= 0) return;
        if (this.alwaysIdle) {
          this.animate({ frame: frameCount }, { duration: frameCount * duration });
        }
      }

      // V14: _prepareAnimation is still overrideable
      _prepareAnimation(destination, options, resolve, reject) {
        if (!this.isSpritesheet) return super._prepareAnimation(destination, options, resolve, reject);
        const steps = [];
        // Handle rotation changes
        if (destination.rotation !== undefined && destination.frame === undefined) {
          const from = this._PRIVATE_animationData?.rotation ?? this.document.rotation;
          if (from !== destination.rotation) {
            // Add rotation step
          }
        }
        // Flatten object changes into animatable steps
        const addSteps = (changes, parent) => {
          for (const [k, v] of Object.entries(changes)) {
            const type = foundry.utils.getType(v);
            if (type === "Object") addSteps(v, parent?.[k]);
            else if (type === "number" || type === "Color") steps.push({ attribute: k, parent, to: v });
          }
        };
        if (this._PRIVATE_animationData) addSteps(destination, this._PRIVATE_animationData);
        return steps;
      }

      _getAnimationData() {
        return { ...super._getAnimationData(), frame: 0 };
      }

      // V14: _onAnimationUpdate is still called during animation ticks
      _onAnimationUpdate(changed, context) {
        const relevant = ["x", "y", "rotation", "frame"].some(k => foundry.utils.hasProperty(changed, k));
        if (!relevant || !this.isSpritesheet || this.#textureCache == null) {
          return super._onAnimationUpdate(changed, context);
        }

        const { sizeX = 100, sizeY = 100 } = game.scenes.active?.grid ?? {};
        const origin = this._origin ?? { x: 0, y: 0 };
        const scale = 2;
        const ax = Math.abs((changed.x ?? origin.x) - origin.x) * scale / sizeX;
        const ay = Math.abs((changed.y ?? origin.y) - origin.y) * scale / sizeY;
        const rawFrame = changed.frame !== undefined ? ~~changed.frame : ~~(ax + ay - Math.min(ax, ay) / 2);

        // Compute direction from _origin to the animation destination.
        // The previous code compared a value to itself, always producing dx=dy=0.
        const destX = context?.to?.x ?? changed.x ?? origin.x;
        const destY = context?.to?.y ?? changed.y ?? origin.y;
        const dx = destX - origin.x;
        const dy = destY - origin.y;

        if (changed.frame != null) {
          this.#isIdle = true;
          if (changed.rotation != null) {
            this.#direction = rotationToDirection(changed.rotation);
          } else if (dx !== 0 || dy !== 0) {
            this.#direction = deltaToDirection(dx, dy);
            this.#isIdle = false;
          }
          this.#frameIndex = rawFrame;
        } else if (dx !== 0 || dy !== 0) {
          this.#isIdle = false;
          this.#direction = deltaToDirection(dx, dy);
          this.#frameIndex = rawFrame;
        } else {
          this.#isIdle = true;
          this.#direction = rotationToDirection(changed.rotation ?? this.document.rotation);
          this.#frameIndex = 0;
        }

        if (this.document._sliding) this.#frameIndex = 1;

        const tex = this.#getCurrentTexture();
        if (tex && this.mesh && this.mesh.texture !== tex) {
          this.mesh.texture = tex;
          this.renderFlags.set({ refreshMesh: true });
        }

        return super._onAnimationUpdate(changed, context);
      }

      async _drawIndicators() {
        if (!this.indicators) return;
        this.indicators.renderable = false;
        this.indicators.removeChildren().forEach(c => c.destroy());
        this.indicators.sortChildren?.();
        this.indicators.renderable = true;
        this.renderFlags.set({ refreshIndicators: true });
      }

      _refreshIndicators() {
        const uiScale = canvas.dimensions.uiScale;
        const iconSize = 20 * uiScale;
        const { height } = this.document.getSize();
        const perCol = Math.floor(height / iconSize + 1e-6);
        let idx = 0;
        if (this.indicators) {
          this.indicators.transform.position.x = this.document.getSize().width - iconSize;
          this.indicators.alpha = 0.75;
          for (const child of this.indicators.children) {
            child.width = child.height = iconSize;
            child.x = Math.floor(idx / perCol) * -iconSize;
            child.y = (idx % perCol) * iconSize;
            idx++;
          }
        }
      }

      _applyRenderFlags(flags) {
        super._applyRenderFlags(flags);
        if (flags.refreshIndicators) this._refreshIndicators();
      }

      // V14: _handleTeleportAnimation is still available
      _handleTeleportAnimation(changes) {
        const snap = {};
        if ("x" in changes) { this._PRIVATE_animationData && (this._PRIVATE_animationData.x = snap.x = changes.x); }
        if ("y" in changes) { this._PRIVATE_animationData && (this._PRIVATE_animationData.y = snap.y = changes.y); }
        if ("elevation" in changes) { this._PRIVATE_animationData && (this._PRIVATE_animationData.elevation = snap.elevation = changes.elevation); }
        if (!foundry.utils.isEmpty(snap)) {
          const ctx = { name: Symbol(this.animationName), to: snap, duration: 0 };
          super._handleTeleportAnimation?.(changes);
        } else {
          super._handleTeleportAnimation?.(changes);
        }
      }
    }

    CONFIG.Token.objectClass = AnimatedToken;

    // Add lockMovement to TokenDocument
    Object.defineProperty(CONFIG.Token.documentClass.prototype, "movable", {
      get() { return (this._movementLocks?.size ?? 0) === 0; }
    });
  });

  // Hooks for spritesheet token updates
  Hooks.on("updateToken", onUpdateTokenSpritesheet);
  Hooks.on("preUpdateToken", onPreUpdateToken);

  if (isAssistantOrAbove()) {
    Hooks.on("createCombatant", onCreateCombatant);
  }
}

function onUpdateTokenSpritesheet(tokenDoc, changes) {
  if (!tokenDoc.object) return;
  const needsRedraw = changes?.texture?.src
    || changes?.flags?.[MODULE_ID]?.sheetstyle
    || changes?.flags?.[MODULE_ID]?.animationframes
    || changes?.flags?.[MODULE_ID]?.spritesheet !== undefined;
  if (!needsRedraw) return;
  // Invalidate spritesheet cache for this token
  const key = generateSpritesheetKey(tokenDoc.texture.src, tokenDoc.object.sheetStyle, tokenDoc.object.animationFrames);
  spritesheetCache.delete(key);
  tokenDoc.object.renderFlags?.set({ redraw: true });
}

function onPreUpdateToken(tokenDoc, changes) {
  // Track speed modifiers for followers
  if (!changes?.animation) return;
  changes.animation.follower_speed_modifiers = {};
}

function onCreateCombatant(combatant) {
  // Refresh idle animation state on entering combat
  const token = combatant.token?.object;
  token?.startIdleAnimation?.();
}

// ─── Token config UI (V14 ApplicationV2 version) ─────────────────────────────
// V14 BREAKING CHANGE: TokenConfig and PrototypeTokenConfig are now ApplicationV2.
// Hook signature: (app, html, context) where:
//   - html is HTMLElement (not jQuery)
//   - app.document replaces app.token (for TokenConfig)
//   - app.actor.prototypeToken replaces app.token (for PrototypeTokenConfig)

function registerTokenConfig() {
  Hooks.on("renderTokenConfig", onRenderTokenConfig);
  Hooks.on("renderPrototypeTokenConfig", onRenderTokenConfig);
}

async function onRenderTokenConfig(app, html, context) {
  // V14: html may be an HTMLElement or a jQuery object depending on the app version.
  // Normalize to plain HTMLElement.
  const formEl = html instanceof HTMLElement ? html : html[0];
  const form = formEl?.querySelector("form") ?? formEl;
  if (!form) return;

  // V14: app.document is the TokenDocument; for PrototypeToken it's app.token
  const tokenDoc = app.document ?? app.token;
  if (!tokenDoc) return;

  const allowPastBounds = game.settings.get(MODULE_ID, "allowTokenArtPastBounds");

  const getSrc = () => {
    return form.querySelector("[name='texture.src'] input[type='text']")?.value
      ?? form.querySelector("[name='texture.src'][type='text']")?.value
      ?? "";
  };

  const getCheckbox = (name, fallback) => {
    const el = form.querySelector(`input[name='flags.${MODULE_ID}.${name}']`);
    return el?.checked !== undefined ? el.checked : (tokenDoc.getFlag(MODULE_ID, name) ?? fallback);
  };

  const refresh = async ({ updateScale = true } = {}) => {
    const src = getSrc();
    const spritesheet = form.querySelector(`input[name='flags.${MODULE_ID}.spritesheet']`)?.checked
      ?? tokenDoc.getFlag(MODULE_ID, "spritesheet")
      ?? false;
    let sheetstyle = form.querySelector(`select[name='flags.${MODULE_ID}.sheetstyle']`)?.value
      ?? tokenDoc.getFlag(MODULE_ID, "sheetstyle")
      ?? "dlru";
    let animationframes = parseInt(form.querySelector(`input[name='flags.${MODULE_ID}.animationframes']`)?.value)
      || tokenDoc.getFlag(MODULE_ID, "animationframes")
      || 4;
    const separateidle = getCheckbox("separateidle", false);
    const noidle = getCheckbox("noidle", false);
    const unlockedanchor = getCheckbox("unlockedanchor", false);
    const unlockedfit = getCheckbox("unlockedfit", false);

    const styleConfig = SHEET_STYLES[sheetstyle];
    if (styleConfig?.frames !== undefined) animationframes = styleConfig.frames;

    const styleOptions = Object.entries(SHEET_STYLES)
      .filter(([, v]) => !v.alias)
      .map(([k, v]) => `<option value="${k}" ${sheetstyle === k ? "selected" : ""}>${game.i18n.localize(v.label)}</option>`)
      .join("");

    // Inject the Sheet checkbox next to texture.src if not already present
    if (!form.querySelector(`[name='flags.${MODULE_ID}.spritesheet']`)) {
      const srcEl = form.querySelector("[name='texture.src']");
      if (srcEl) {
        const label = document.createElement("label");
        label.textContent = "Sheet";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.name = `flags.${MODULE_ID}.spritesheet`;
        if (spritesheet) checkbox.checked = true;
        srcEl.before(label);
        srcEl.before(checkbox);
        checkbox.addEventListener("change", () => refresh());
      }
    } else {
      form.querySelector(`[name='flags.${MODULE_ID}.spritesheet']`).checked = spritesheet;
    }

    // Inject texture.fit, anchorX, anchorY if missing
    for (const [field, fieldConfig] of [
      ["fit", { label: "Fit", type: "select", choices: ["fill", "contain", "cover", "width", "height"] }],
      ["anchorX", { label: "Anchor X", type: "number" }],
      ["anchorY", { label: "Anchor Y", type: "number" }],
    ]) {
      if (!form.querySelector(`[name='texture.${field}']`)) {
        const sizeFieldset = form.querySelector("fieldset.size") ?? form;
        const div = document.createElement("div");
        div.className = `form-group ${field}`;
        div.innerHTML = `<label>${fieldConfig.label}</label><div class="form-fields">
          ${fieldConfig.type === "select"
            ? `<select name="texture.${field}">${fieldConfig.choices.map(c => `<option value="${c}">${c}</option>`).join("")}</select>`
            : `<input type="number" name="texture.${field}" step="0.01" value="${tokenDoc?.texture?.[field] ?? (field === "fit" ? "contain" : 0.5)}">`
          }</div>`;
        sizeFieldset.appendChild(div);
      }
    }

    // Render spritesheet config section
    const showframes = styleConfig?.frames === undefined;
    const showidle = game.settings.get(MODULE_ID, "playIdleAnimations") && !separateidle;
    const hide = !spritesheet;
    const hideaux = !spritesheet;

    const configHtml = await foundry.applications.handlebars.renderTemplate(
      `modules/${MODULE_ID}/templates/token-settings.hbs`,
      { MODULENAME: MODULE_ID, spritesheet, sheetstyle, animationframes, separateidle, noidle, showidle, showframes, hide, hideaux, sheetStyleOptions: styleOptions }
    );

    let configEl = form.querySelector(".spritesheet-config");
    if (!configEl) {
      const srcGroup = form.querySelector("[name='texture.src']")?.closest(".form-group");
      if (srcGroup) {
        const div = document.createElement("div");
        div.className = "spritesheet-config";
        srcGroup.after(div);
        configEl = div;
      }
    }
    form.querySelector(".spritesheet-config-aux")?.remove();
    if (configEl) configEl.outerHTML = configHtml; // replaceWith parsed HTML

    // Temporarily insert via innerHTML to parse properly
    const wrapper = document.createElement("div");
    wrapper.innerHTML = configHtml;
    if (configEl) configEl.replaceWith(...wrapper.children);

    // Ensure hidden fields exist
    for (const field of ["fit", "anchorX", "anchorY"]) {
      if (!form.querySelector(`[name='texture.${field}']`)) {
        const input = document.createElement("input");
        input.name = `texture.${field}`;
        input.value = tokenDoc?.texture?.[field] ?? "";
        input.hidden = true;
        form.appendChild(input);
      }
    }

    if (!allowPastBounds) return;

    // Anchor lock toggle
    if (spritesheet) {
      // Set PTR2e autoscale flag off
      if (game.system.id === "ptr2e" && !form.querySelector("input[name='flags.ptr2e.autoscale']")) {
        const input = document.createElement("input");
        input.name = "flags.ptr2e.autoscale";
        input.type = "hidden";
        input.value = "false";
        form.appendChild(input);
      }

      // Compute anchor from texture.
      // Bug fix: loadTexture on a missing/empty src can hang indefinitely, blocking
      // the canvas input thread and causing scroll/zoom to freeze when dragging a token.
      // Guard against empty src and race the load against a short timeout.
      let tw, th;
      if (src) {
        try {
          const texResult = await Promise.race([
            foundry.canvas.loadTexture(src, { fallback: CONST.DEFAULT_TOKEN }),
            new Promise((_, reject) => setTimeout(() => reject(new Error("texture load timeout")), 3000))
          ]);
          tw = texResult?.width;
          th = texResult?.height;
        } catch (e) {
          console.warn(`Dylan's Animated Tokens: texture load skipped — ${e.message}`);
        }
      }
      if (!tw || !th) { return; } // can't compute anchor without dimensions
      if (tw && th) {
        const defaultRatio = styleConfig?.defaultRatio ?? 4 / animationframes;
        const ratio = (th / tw) * defaultRatio;
        const scale = form.querySelector("range-picker[name='scale'], input[name='scale']")?.value ?? 1;
        let anchorY;
        const anchorOverride = styleConfig?.anchor;
        if (anchorOverride !== undefined) {
          anchorY = anchorOverride;
        } else {
          switch (sheetstyle) {
            case "pmd": case "eight": anchorY = 0.5; break;
            default: anchorY = 1.02 + 0.5 / (-ratio * scale);
          }
        }

        if (!unlockedfit) {
          const fitEl = form.querySelector("[name='texture.fit']");
          if (fitEl) fitEl.value = "width";
        }
        if (!unlockedanchor) {
          const axEl = form.querySelector("[name='texture.anchorX']");
          const ayEl = form.querySelector("[name='texture.anchorY']");
          if (axEl) axEl.value = 0.5;
          if (ayEl) ayEl.value = Math.ceil(anchorY * 100) / 100;
        }
      }
    } else {
      if (!unlockedfit) {
        const fitEl = form.querySelector("[name='texture.fit']");
        if (fitEl) fitEl.value = "contain";
      }
      if (!unlockedanchor) {
        const axEl = form.querySelector("[name='texture.anchorX']");
        const ayEl = form.querySelector("[name='texture.anchorY']");
        if (axEl) axEl.value = 0.5;
        if (ayEl) ayEl.value = 0.5;
      }
    }
  };

  await refresh();

  // Wire up change listeners
  // V14: html is HTMLElement, use addEventListener directly
  const targetEl = html instanceof HTMLElement ? html : html[0];
  targetEl?.addEventListener("change", async (e) => {
    const name = e.target?.name ?? "";
    if (
      name === "texture.src"
      || name.includes("[name='texture.src']")
      || name === `flags.${MODULE_ID}.spritesheet`
      || name === `flags.${MODULE_ID}.sheetstyle`
      || name === `flags.${MODULE_ID}.animationframes`
    ) {
      await refresh();
    }
    if (name === "scale") {
      await refresh({ updateScale: false });
    }
  });
}

// ─── Tokens layer (collision) ─────────────────────────────────────────────────

function registerTokensLayer() {
  // V14: CONFIG.Canvas.layers.tokens.layerClass is still the way to extend the layer
  Hooks.on("canvasConfig", () => {
    const BaseLayer = CONFIG.Canvas.layers.tokens.layerClass;

    class AnimatedTokenLayer extends BaseLayer {
      isOccupiedGridSpaceBlocking(point, token, { preview = false } = {}) {
        if (!game.settings.get(MODULE_ID, "tokenCollision")) {
          return super.isOccupiedGridSpaceBlocking?.(point, token, { preview }) ?? false;
        }
        return this.#getBlockingTokens(point, token, { preview })
          .some(t => !(
            token.document.disposition === t.document.disposition
            && !game.settings.get(MODULE_ID, "tokenCollisionAllied")
          ));
      }

      #getBlockingTokens(point, token, { preview = false } = {}) {
        return (preview ? this.preview?.children ?? [] : this.placeables).filter(t => {
          if (t === token || t.document.hidden && !game.settings.get(MODULE_ID, "tokenCollisionHidden")) return false;
          const bounds = t.bounds;
          return bounds && bounds.contains(point.x, point.y);
        });
      }
    }

    CONFIG.Canvas.layers.tokens.layerClass = AnimatedTokenLayer;
  });
}

// ─── Movement wrappers ────────────────────────────────────────────────────────

function registerMovement() {
  // Wrap _getMovableObjects to respect lockMovement
  libWrapper.register(MODULE_ID, "foundry.canvas.layers.PlaceablesLayer.prototype._getMovableObjects",
    function(wrapped, ids, controlled) {
      return wrapped(ids, controlled).filter(t => controlled || (t?.document?.movable ?? true));
    }, "WRAPPER"
  );

  // Wrap Scene.prototype.updateEmbeddedDocuments to inject follower updates
  libWrapper.register(MODULE_ID, "Scene.prototype.updateEmbeddedDocuments",
    function(wrapped, type, updates = [], options = {}) {
      if (type !== "Token" || options?.follower_updates) return wrapped(type, updates, options);
      const followerUpdates = [];
      for (const update of updates) {
        const token = this.tokens.get(update._id);
        if (token) Hooks.call(`${MODULE_ID}.manualMove`, token, update, options, followerUpdates);
      }
      const allUpdates = [...updates, ...followerUpdates.filter(u => canvas.scene.tokens.get(u._id)?.isOwner)];
      const gmOnlyUpdates = followerUpdates.filter(u => !canvas.scene.tokens.get(u._id)?.isOwner);
      return wrapped(type, allUpdates, { ...options, follower_updates: gmOnlyUpdates });
    }, "WRAPPER"
  );

  // Wrap teleport region behavior for follower teleportation
  libWrapper.register(MODULE_ID,
    "foundry.data.regionBehaviors.TeleportTokenRegionBehaviorType.events.tokenMoveIn",
    async function(wrapped, event) {
      if (!this.destination || event.data.movement.passed.waypoints.at(-1).action === "displace") return;
      if (!(fromUuidSync(this.destination) instanceof RegionDocument)) {
        console.error(`${this.destination} does not exist`);
        return;
      }
      const tokenDoc = event.data.token;
      if (tokenDoc.getFlag(MODULE_ID, FOLLOW_FLAG)?.who) return;

      const followers = getFollowers(tokenDoc);
      const controlled = canvas.tokens.controlled.some(t => t.document.id === tokenDoc.id);
      const destScene = (await fromUuid(this.destination))?.parent ?? getScene(tokenDoc);
      const changingScene = destScene?.id !== getScene(tokenDoc)?.id;

      if (changingScene) await tokenDoc.update({ [`flags.${MODULE_ID}.${FOLLOW_FLAG}.originalid`]: tokenDoc.id });
      if (await wrapped(event) === false) return false;

      let movedToken = tokenDoc;
      if (changingScene) {
        movedToken = destScene.tokens.find(t => t.getFlag(MODULE_ID, FOLLOW_FLAG)?.originalid === tokenDoc.id);
        if (!movedToken) { ui.notifications.warn("Teleporting token not found in new scene"); return; }
      }

      if (followers.length > 0) {
        await teleportFollowers(followers.map(f => f.uuid), { x: movedToken.x, y: movedToken.y }, destScene.id, tokenDoc.id, movedToken.id);
      }
      if (changingScene && controlled) movedToken.object?.control?.(true, { releaseOthers: false });
    }, "MIXED"
  );

  CONFIG.Token.documentClass.prototype.lockMovement = function() {
    const lockId = foundry.utils.randomID();
    this._movementLocks ??= new Set();
    this._movementLocks.add(lockId);
    return () => this._movementLocks.delete(lockId);
  };
}

// ─── Follow keybinding ────────────────────────────────────────────────────────

function registerFollowKeybinding() {
  if (!game.settings.get(MODULE_ID, "enableFollow")) return;

  Hooks.on("updateToken", onUpdateTokenFollow);
  Hooks.on(`${MODULE_ID}.manualMove`, onManualMoveFollow);

  registerSocketFunction("TeleportFollowers", teleportFollowers);

  game.keybindings.register(MODULE_ID, "follow", {
    name: "Follow Token",
    hint: "The key to join or leave the line of tokens being followed.",
    editable: [{ key: "KeyL" }],
    onDown: onFollowKeyDown,
    restricted: false,
    precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL
  });
}

function onUpdateTokenFollow(tokenDoc, changes, options) {
  // Speed modifiers for followers
  if (!options?.follower_updates || !options.follower_updates.length || (!isActiveGM() && hasActiveGM())) return;
  // Process follower movement from the update options
}

function onManualMoveFollow(token, update, options, followerUpdates) {
  if (!update.x && !update.y) return;
  const followers = getFollowers(token);
  if (!followers.length) return;
  const movementMap = options.movement ?? {};
  const updates = buildFollowerUpdates(token, movementMap, followers);
  followerUpdates.push(...updates);
}

function onFollowKeyDown() {
  const hover = canvas?.tokens?.hover?.id;
  const controlled = (canvas?.tokens?.controlled ?? []).map(t => t.id);
  if (!hover || !controlled.length) return;

  const followMap = getFollowMap(canvas.scene);
  const updates = [];

  for (const cid of controlled) {
    const token = canvas.scene.tokens.get(cid);
    if (!token) continue;
    const currentFollow = token.getFlag(MODULE_ID, FOLLOW_FLAG)?.who;
    if (currentFollow === hover) {
      updates.push({ _id: cid, [`flags.${MODULE_ID}.${FOLLOW_FLAG}.who`]: null });
    } else {
      // Check for cycles
      const cycle = getFollowCycle(token);
      const target = canvas.scene.tokens.get(hover);
      if (target && !cycle.has(target)) {
        updates.push({ _id: cid, [`flags.${MODULE_ID}.${FOLLOW_FLAG}.who`]: hover });
      } else {
        ui.notifications.warn(game.i18n.format("DAT.FollowMe.Cycle", { name: token.name }));
      }
    }
  }

  if (updates.length) canvas.scene.updateEmbeddedDocuments("Token", updates, { follower_updates: [] });
}

// ─── Idle animation on canvas ready ──────────────────────────────────────────

function registerCanvasHooks() {
  Hooks.on("canvasReady", (canvas) => {
    try {
      canvas?.tokens?.objects?.children?.forEach(t => t?.startIdleAnimation?.());
    } catch (e) { console.error("canvasReady idle animation:", e); }
  });

  Hooks.on("createToken", (tokenDoc) => {
    try {
      setTimeout(() => tokenDoc?.object?.startIdleAnimation?.(), 200);
    } catch (e) { console.error("createToken idle animation:", e); }
  });
}

// ─── Module compatibility patches ─────────────────────────────────────────────

function registerModuleCompatibility() {
  // PTU/PTR2e autoscale compatibility is handled in the token config renderer above
  // Isometric perspective: handled in AnimatedToken.isIsometric getter
}

// ─── Entry point ─────────────────────────────────────────────────────────────

Hooks.on("init", () => {
  // Expose API
  game.modules.get(MODULE_ID).api = {
    spritesheetGenerator: { getTexturesForToken, generateKey: generateSpritesheetKey },
    SHEET_STYLES,
    DIRECTIONS,
  };

  const modules = [
    ["migration", registerMigration],
    ["settings", registerSettings],
    ["tokensLayer", registerTokensLayer],
    ["token", registerTokenClass],
    ["tokenConfig", registerTokenConfig],
    ["tokenMovement", registerMovement],
    ["pixelate", registerPixelate],
    ["canvas", registerCanvasHooks],
    ["moduleCompatibility", registerModuleCompatibility],
  ];

  for (const [name, fn] of modules) {
    try { fn(); }
    catch (e) { console.error(`dylans-animated-tokens: ${name}.register() error:`, e); }
  }
});

// Follow keybinding registered on ready (needs keybindings API)
Hooks.on("ready", () => {
  try { registerFollowKeybinding(); }
  catch (e) { console.error("dylans-animated-tokens: followKeybinding.register() error:", e); }
});

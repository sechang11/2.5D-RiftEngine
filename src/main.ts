/**
 * Entry point: builds the world, wires the loop, and starts running.
 *
 * The frame is deliberately ordered so that input, simulation and rendering
 * each see a consistent snapshot:
 *
 *   1. read input and translate it into commands
 *   2. advance the simulation by whole fixed ticks
 *   3. render an interpolated view of the result
 *   4. clear edge-triggered input
 *
 * Note that input runs before the simulation. A click and the tick that acts on
 * it land in the same frame, which is the difference between controls that feel
 * immediate and controls that feel like they lag by one frame.
 *
 * The editor sits alongside the game rather than replacing it. Toggling it does
 * not tear anything down: the simulation keeps running underneath, which is why
 * a prop placed in the editor immediately blocks pathfinding and a weapon
 * dropped on the ground can be walked over the moment you switch back.
 */

import './styles.css';
import { Sim } from './core/sim/sim';
import { Team } from './core/ecs/types';
import { buildMap01 } from './game/content/map01';
import { buildScenario } from './game/scenario';
import { Renderer } from './render/renderer';
import { InputState } from './input/input';
import { PlayerController } from './input/controller';
import { Hud } from './ui/hud';
import { Minimap } from './ui/minimap';
import { CommandType } from './core/sim/commands';
import { AssetRegistry } from './render/assets';
import { PropStore } from './core/world/props';
import { Editor } from './editor/editor';
import { PickupSystem } from './game/pickups';
import { dressMap } from './game/dressing';
import * as scene from './game/scene';

const MAP_SEED = 9090;
const SIM_SEED = 20260909;

async function boot(): Promise<void> {
  const app = document.getElementById('app');
  const canvas = document.getElementById('scene') as HTMLCanvasElement | null;
  const overlayCanvas = document.getElementById('overlay') as HTMLCanvasElement | null;
  const hudRoot = document.getElementById('hud');
  if (!app || !canvas || !overlayCanvas || !hudRoot) {
    throw new Error('Missing required DOM nodes');
  }

  const map = buildMap01(MAP_SEED);
  const sim = new Sim(map.nav, { tickRate: 60, seed: SIM_SEED });
  const scenario = buildScenario(sim, map);

  // The asset pack is optional. Without it the engine runs exactly as before,
  // with procedural characters and an empty editor palette.
  const assets = new AssetRegistry();
  const assetCount = await assets.loadManifest();

  const props = new PropStore(map.nav);

  // Prime the fog before the first frame so the map does not flash fully lit.
  sim.fog.update(sim.world.units);

  const renderer = new Renderer(app, canvas, overlayCanvas, sim, map, {
    viewTeam: Team.Blue,
    fogEnabled: true,
    assets,
    props,
  });

  const hud = new Hud(hudRoot);
  const input = new InputState(app);
  const minimap = new Minimap(hud.minimapMount, map, sim, renderer.camera, Team.Blue);

  const controller = new PlayerController(
    input,
    sim,
    renderer.camera,
    renderer.views,
    renderer.indicators,
    {
      onToggleGrid: (on) => renderer.setGrid(on),
      onToggleFog: (on) => renderer.setFogEnabled(on),
      onToggleViewTeam: (team) => {
        renderer.setViewTeam(team);
        minimap.setViewTeam(team);
      },
      onSpawnWave: () => {
        scenario.spawnWaves();
        hud.log(`Minion wave ${scenario.waveCount} deployed`);
      },
      onLog: (message) => hud.log(message),
    },
  );

  controller.playerUnit = scenario.player.id;
  renderer.views.selection.add(scenario.player.id);
  renderer.camera.jumpTo(scenario.player.pos.x, scenario.player.pos.y);

  minimap.onOrder = (x, y) => {
    const champion = controller.champion;
    if (champion) sim.commands.emit(CommandType.Move, champion.id, x, y);
  };

  // --- editor and items ----------------------------------------------------

  const editor = renderer.propViews
    ? new Editor({
        container: hudRoot,
        threeScene: renderer.scene,
        assets,
        props,
        propViews: renderer.propViews,
        camera: renderer.camera,
        input,
        sim,
        mapSeed: MAP_SEED,
        mapName: map.name,
        onLog: (m) => hud.log(m),
        onModeChange: (on) => hud.setEditorMode(on),
      })
    : null;

  const pickups = new PickupSystem(sim, props, assets);
  pickups.onPickup = ({ unit, item, replaced }) => {
    hud.log(`${unit.name} picked up ${item.name}`);
    hud.toast(`${item.name} — ${item.description}${replaced ? ' (swapped)' : ''}`);
  };

  // Restore whatever was last being worked on, so a reload does not lose a
  // dressing session. With nothing saved and a pack available, scatter a
  // starting layout rather than opening onto bare terrain.
  const saved = scene.loadLocal('autosave');
  if (saved) {
    // Props only on boot. The scenario has already populated the world with
    // camps, towers and a minion wave, and a save taken mid-session contains a
    // snapshot of those plus whatever minions happened to be alive; restoring
    // them here would stack a second set on top. Loading a scene from inside
    // the editor does replace units, which is what that action should mean.
    const result = scene.deserialize(saved, props, sim, {
      spawnUnits: false,
      radiusOf: (id) => assets.get(id)?.radius ?? 0.5,
    });
    await assets.loadAll(new Set(props.props.map((p) => p.assetId)));
    hud.log(`Restored ${result.props} placed objects`);
  } else if (assetCount > 0) {
    const report = dressMap(map, props, assets, { seed: 0x5eed1e, density: 1 });
    await assets.loadAll(new Set(props.props.map((p) => p.assetId)));
    hud.log(`Dressed the map with ${report.placed} objects`);
  }

  const resize = () => renderer.resize();
  window.addEventListener('resize', resize);
  resize();

  hud.log(
    assetCount > 0
      ? `Hollow Reach loaded with ${assetCount} assets. F2 for the editor.`
      : 'Hollow Reach loaded. No asset pack found; editor palette will be empty.',
  );
  hud.toast('Right click to move · Q W E R to cast · F2 for the editor');

  let last = performance.now();
  let elapsed = 0;
  let statsTimer = 0;

  const frame = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    elapsed += dt;

    const rect = app.getBoundingClientRect();

    // F2 swaps between playing and editing. The check sits outside the
    // controller so it works in both modes.
    if (input.wasPressed('F2') && editor) editor.toggle();
    if (editor?.active) {
      if (
        (input.isHeld('ControlLeft') || input.isHeld('ControlRight')) &&
        !editor.capturingKeys
      ) {
        if (input.wasPressed('KeyZ')) editor.undo();
        if (input.wasPressed('KeyY')) editor.redo();
      }
      // The editor drives the camera itself while it is open.
      editor.update(dt, rect.width, rect.height);
    } else {
      renderer.camera.edgePanEnabled = true;
      controller.update(dt, rect.width, rect.height);
    }

    sim.advance(dt);
    pickups.update();

    renderer.render(dt, elapsed, controller.toggles.showPaths);
    minimap.update(controller.toggles.fogEnabled);
    hud.update(sim, controller, controller.champion, dt, renderer.frameMs);

    statsTimer += dt;
    if (statsTimer >= 1) {
      statsTimer = 0;
      sim.resetCounters();
    }

    input.endFrame();
    requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);

  /**
   * Saves the current game view to a file under the project root.
   *
   * The WebGL context does not preserve its drawing buffer, so the frame has
   * to be re-rendered and read back in the same task; anything that yields in
   * between hands back a blank canvas. The 2D overlay is composited on top so
   * health bars and floating text are included.
   *
   * Dev server only. See the screenshot sink in vite.config.ts.
   */
  const capture = async (path = 'docs/screenshot.jpg', width = 1280, quality = 0.92) => {
    renderer.render(1 / 60, elapsed, controller.toggles.showPaths);
    const height = Math.round((width * canvas.height) / canvas.width);
    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    const ctx = out.getContext('2d');
    if (!ctx) throw new Error('capture needs a 2D context');
    ctx.drawImage(canvas, 0, 0, width, height);
    ctx.drawImage(overlayCanvas, 0, 0, width, height);
    const dataUrl = out.toDataURL('image/jpeg', quality);
    const res = await fetch('/__capture', {
      method: 'POST',
      body: JSON.stringify({ path, dataUrl }),
    });
    return res.text();
  };

  // Expose the running game for console poking. Invaluable while building an
  // engine, and harmless: it is a read/write handle to the same objects the
  // loop already owns.
  Object.assign(window as unknown as Record<string, unknown>, {
    engine: {
      sim,
      map,
      renderer,
      controller,
      scenario,
      hud,
      minimap,
      assets,
      props,
      editor,
      pickups,
      capture,
      scene,
      /** Re-scatter the map. `engine.dress(1.5)` for a denser world. */
      dress: async (density = 1, seed = Math.floor(Math.random() * 1e9)) => {
        props.clear();
        const report = dressMap(map, props, assets, { seed, density });
        await assets.loadAll(new Set(props.props.map((p) => p.assetId)));
        hud.log(`Dressed the map with ${report.placed} objects`);
        return report;
      },
    },
  });
}

void boot();

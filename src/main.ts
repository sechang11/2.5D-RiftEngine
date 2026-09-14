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
 * Several worlds run through this same wiring, chosen by `?mode=`:
 *
 *   battle     the MOBA sandbox on Hollow Reach
 *   museum     every asset in the pack laid out as a gallery you walk through
 *   city       Highhold, the pack assembled into a planned city
 *   showcase   one authored character and one authored building, up close
 *
 * The museum is not a debug view bolted on the side. It is a second game built
 * from the same map, scenario and content layers, which is the only honest test
 * of whether those layers are actually separable.
 *
 * The editor sits alongside all of them rather than replacing them. Toggling it
 * does not tear anything down: the simulation keeps running underneath, which
 * is why a prop placed in the editor immediately blocks pathfinding and a weapon
 * dropped on the ground can be walked over the moment you switch back.
 */

import './styles.css';
import { Sim } from './core/sim/sim';
import { Team } from './core/ecs/types';
import { vec2 } from './core/math/vec2';
import { buildMap01 } from './game/content/map01';
import { buildScenario, spawnUnit, type Scenario } from './game/scenario';
import { buildMuseum, populateMuseum, type MuseumLayout } from './game/museum';
import { buildCity, populateCity, type CityMap } from './game/content/city';
import {
  buildShowcase,
  populateShowcase,
  SHOWCASE_BUILDING,
  SHOWCASE_SUN,
  type ShowcaseLayout,
} from './game/showcase';
import { ARCHETYPES } from './game/content/units';

import { Renderer } from './render/renderer';
import { InputState, MouseButton } from './input/input';
import { PlayerController } from './input/controller';
import { Hud } from './ui/hud';
import { Minimap } from './ui/minimap';
import { CommandType } from './core/sim/commands';
import { AssetRegistry } from './render/assets';
import { BuildingModels } from './render/buildings';
import { CharacterModels } from './render/characters';
import { PropStore } from './core/world/props';
import { Editor } from './editor/editor';
import { PickupSystem } from './game/pickups';
import { dressMap } from './game/dressing';
import type { WorldLabel } from './render/overlay';
import * as scene from './game/scene';

const MAP_SEED = 9090;
const CITY_SEED = 4711;
const SIM_SEED = 20260909;

/** The photographed sky authored models are lit by. */
const SKY_URL = '/assets/env/sky_1k.hdr';

async function boot(): Promise<void> {
  const app = document.getElementById('app');
  const canvas = document.getElementById('scene') as HTMLCanvasElement | null;
  const overlayCanvas = document.getElementById('overlay') as HTMLCanvasElement | null;
  const hudRoot = document.getElementById('hud');
  if (!app || !canvas || !overlayCanvas || !hudRoot) {
    throw new Error('Missing required DOM nodes');
  }

  const params = new URLSearchParams(location.search);
  const mode = params.get('mode') ?? 'battle';
  const museumMode = mode === 'museum';
  const cityMode = mode === 'city';
  const showcaseMode = mode === 'showcase';

  // The asset pack is loaded first because the museum's layout is derived from
  // it: the map cannot be sized until the exhibits are known. Without a pack
  // the engine still runs, with procedural characters and an empty palette.
  //
  // Authored models load alongside it. One that fails leaves its units on
  // primitives, or its plot empty, so no load waits on another succeeding.
  const assets = new AssetRegistry();
  const characters = new CharacterModels();
  const buildings = new BuildingModels();
  const models = Object.values(ARCHETYPES).flatMap((a) => (a.model ? [a.model] : []));
  const [assetCount] = await Promise.all([
    assets.loadManifest(),
    characters.load(models),
    showcaseMode ? buildings.load([SHOWCASE_BUILDING]) : Promise.resolve(),
  ]);

  let map;
  let layout: MuseumLayout | null = null;
  let city: CityMap | null = null;
  let showcase: ShowcaseLayout | null = null;
  if (museumMode) {
    layout = buildMuseum(assets, (params.get('category') ?? '').split(',').filter(Boolean));
    map = layout.map;
  } else if (cityMode) {
    // The city sizes its plots from the catalogue, so it is built after the
    // manifest and before anything that needs a map.
    city = buildCity(CITY_SEED, assets);
    map = city;
  } else if (showcaseMode) {
    // The building's footprint is stamped into the map, so it has to be known
    // before the map exists.
    showcase = buildShowcase(buildings.footprint(SHOWCASE_BUILDING));
    map = showcase.map;
  } else {
    map = buildMap01(MAP_SEED);
  }

  const sim = new Sim(map.nav, { tickRate: 60, seed: SIM_SEED });
  const props = new PropStore(map.nav);

  let scenario: Scenario | null = null;
  let playerId: number;
  if (museumMode && layout) {
    playerId = populateMuseum(sim, layout, props, assets).player.id;
    await assets.loadAll(new Set(props.props.map((p) => p.assetId)));
  } else if (cityMode && city) {
    populateCity(city.plan, props, assets);
    props.rebuildNav(true);
    const visitor = spawnUnit(sim, 'warden', Team.Blue, vec2(city.plan.entrance.x, city.plan.entrance.y));
    visitor.name = 'Traveller';
    playerId = visitor.id;
    await assets.loadAll(new Set(props.props.map((p) => p.assetId)));
  } else if (showcaseMode && showcase) {
    playerId = populateShowcase(sim, showcase).player.id;
  } else {
    scenario = buildScenario(sim, map);
    playerId = scenario.player.id;
  }

  // Prime the fog before the first frame so the map does not flash fully lit.
  sim.fog.update(sim.world.units);

  const renderer = new Renderer(app, canvas, overlayCanvas, sim, map, {
    viewTeam: Team.Blue,
    // A gallery you cannot see across is not a gallery.
    fogEnabled: !museumMode && !cityMode && !showcaseMode,
    // Gallery partitions, not cliffs: low enough to see over from the fixed
    // camera, high enough to read as rooms.
    wallHeight: museumMode ? 1.15 : undefined,
    wallVariation: museumMode ? 0.12 : undefined,
    // The city paves its streets with the lane mask, so that is what the
    // cobbles follow; outside the walls the same mask is the road.
    ground: cityMode || showcaseMode ? { base: 'grass_meadow', lane: 'cobblestone', dirt: 'dirt_grey' } : undefined,
    assets,
    characters,
    props,
    // The showcase is for looking closely: down to eye level and looking at
    // the face rather than the feet, with shadows tight enough to show a strap.
    camera: showcaseMode
      ? { distance: 12, minDistance: 1.4, maxDistance: 60, minPitchDegrees: 3, pitchEaseDistance: 24, focusHeight: 1.9 }
      : undefined,
    shadowExtent: showcaseMode ? 28 : undefined,
    hazeScale: showcaseMode ? 0.45 : undefined,
    groundShadows: showcaseMode,
    // The meadow was generated to read from a hundred units up, where its
    // green is a colour. At eye level it is most of the frame, and at full
    // strength it is louder than anything standing on it.
    groundTint: showcaseMode ? { base: 0xb4bc96 } : undefined,
    groundSaturation: showcaseMode ? 0.6 : undefined,
  });

  if (showcase?.building) {
    const { id, x, z, turn } = showcase.building;
    const building = buildings.create(id, x, z, turn);
    if (building) renderer.scene.add(building);
    buildings.setAnisotropy(renderer.renderer.capabilities.getMaxAnisotropy());
  }

  // Authored models are lit by a photographed sky in every world. The
  // showcase gives the whole scene that sky, shows it, and turns it so the sun
  // comes over the camera's shoulder.
  void renderer
    .loadSky(SKY_URL, {
      world: showcaseMode,
      background: showcaseMode,
      sunAzimuth: showcaseMode ? SHOWCASE_SUN : undefined,
    })
    .catch((err) => console.warn('[sky] did not load:', err));

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
        if (!scenario) {
          hud.log('No lanes to march down here');
          return;
        }
        scenario.spawnWaves();
        hud.log(`Minion wave ${scenario.waveCount} deployed`);
      },
      onLog: (message) => hud.log(message),
    },
  );

  controller.playerUnit = playerId;
  controller.toggles.fogEnabled = !museumMode && !cityMode && !showcaseMode;
  // Looking at one character means keeping him in frame, with nothing drawn
  // round his feet that says which team he is on or how far he can shoot.
  if (showcaseMode) {
    controller.toggles.cameraLocked = true;
    renderer.views.ringsVisible = false;
    renderer.indicators.attackRangeVisible = false;
  }
  renderer.views.selection.add(playerId);
  const player = sim.world.get(playerId);
  if (player) renderer.camera.jumpTo(player.pos.x, player.pos.y);

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

  if (museumMode && layout) {
    // Captions: one per exhibit, plus a sign over every gallery door.
    const labels: WorldLabel[] = [];
    for (const gallery of layout.galleries) {
      labels.push({
        x: gallery.signX,
        y: gallery.signY,
        height: 8,
        text: gallery.category.toUpperCase(),
        sub: `${gallery.count} assets`,
        size: 15,
        colour: '#7dffa8',
      });
    }
    for (const exhibit of layout.exhibits) {
      const surface = assets.surfaceOf(exhibit.assetId);
      labels.push({
        x: exhibit.x,
        y: exhibit.y,
        // Just above the mesh, so a tower's label is not buried in its roof.
        height: exhibit.height + 1.4,
        text: exhibit.name,
        // The surfaces are named in the caption because the museum is where a
        // wrong material gets caught, and "that roof is thatch" is not a
        // conclusion you can reach by looking at a thatched roof you expected
        // to be slate.
        sub:
          `${exhibit.size.map((v) => v.toFixed(1)).join(' × ')}  ·  ${exhibit.triangles} tris` +
          (surface ? `  ·  ${surface.side}${surface.top !== surface.side ? ' / ' + surface.top : ''}` : ''),
      });
    }
    renderer.overlay.labels = labels;
    renderer.overlay.labelRange = 60;
    hud.log(`Museum: ${layout.exhibits.length} exhibits in ${layout.galleries.length} galleries.`);
    hud.toast('Right click to walk. Every asset in the pack is on this map.');
  } else if (cityMode && city) {
    renderer.overlay.labels = city.plan.landmarks.map((l) => ({
      x: l.x,
      y: l.y,
      height: 7.5,
      text: l.name.toUpperCase(),
      size: 14,
      colour: '#ffd9a0',
    }));
    renderer.overlay.labelRange = 70;
    hud.log(
      `Highhold: ${city.plan.placements.length} pieces, ` +
        `${city.plan.districts.length} districts, ${city.plan.gates.length} gates.`,
    );
    hud.toast('Right click to walk. Mouse wheel zooms right in.');
  } else if (showcaseMode) {
    hud.log(characters.has('ranger') ? 'Showcase: the Ranger.' : 'Showcase: the ranger model did not load.');
    if (!showcase?.building) hud.log('Showcase: the cottage did not load.');
    hud.toast('Right click to walk · Q W E R to cast · Z and C turn the view · wheel down to the face');
  } else {
    // Restore whatever was last being worked on, so a reload does not lose a
    // dressing session. With nothing saved and a pack available, scatter a
    // starting layout rather than opening onto bare terrain.
    const saved = scene.loadLocal('autosave');
    if (saved) {
      // Props only on boot. The scenario has already populated the world with
      // camps, towers and a minion wave, and a save taken mid-session contains
      // a snapshot of those plus whatever minions happened to be alive;
      // restoring them here would stack a second set on top. Loading a scene
      // from inside the editor does replace units, which is what that action
      // should mean.
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

    hud.log(
      assetCount > 0
        ? `Hollow Reach loaded with ${assetCount} assets. F2 for the editor.`
        : 'Hollow Reach loaded. No asset pack found; editor palette will be empty.',
    );
    hud.toast('Right click to move · Q W E R to cast · F2 for the editor');
  }

  const resize = () => renderer.resize();
  window.addEventListener('resize', resize);
  resize();

  let last = performance.now();
  let elapsed = 0;
  let statsTimer = 0;
  let lastMouseX = input.mouseX;

  /** Turns the showcase camera: Z and C, or dragging with the middle button. */
  const orbit = (dt: number) => {
    let turn = 0;
    if (input.isHeld('KeyZ')) turn -= dt * 1.8;
    if (input.isHeld('KeyC')) turn += dt * 1.8;
    if (input.buttonsHeld.has(MouseButton.Middle)) turn -= (input.mouseX - lastMouseX) * 0.008;
    lastMouseX = input.mouseX;
    if (turn !== 0) renderer.camera.orbit(turn);
  };

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
      if (showcaseMode) orbit(dt);
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

  // Compile the shaders the first frame needs before drawing it, in parallel
  // where the browser allows. Left to the first frame, a building's materials,
  // a character's and their shadow variants compile one after another on the
  // main thread and the first frame waits for all of them. Unit views are made
  // first so their materials are in the scene to be found.
  //
  // Bounded, because readiness is polled on a timer and a background tab
  // stretches timers to a minute apart: a page opened out of sight would
  // otherwise not start until long after it came back into view.
  renderer.views.update(sim.alpha, 0, 0, controller.toggles.fogEnabled);
  await Promise.race([
    renderer.renderer.compileAsync(renderer.scene, renderer.camera.camera).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
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
      layout,
      showcase,
      hud,
      minimap,
      assets,
      characters,
      buildings,
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

/**
 * Editor chrome: the asset palette, the inspector, and the toolbar.
 *
 * Built as DOM rather than drawn into the canvas. An editor is mostly lists,
 * text fields and buttons, and every one of those is free here and expensive
 * in a 3D context. It also means the palette scrolls, the search box has focus
 * handling, and the whole panel scales with the browser's zoom, none of which
 * would be worth writing by hand.
 *
 * This module owns no state. It renders whatever the editor tells it to and
 * reports clicks back through callbacks, so the editor remains testable and the
 * panel can be rebuilt at any time.
 */

import type { Prop } from '../core/world/props';
import { PropFlag } from '../core/world/props';

export interface PaletteItem {
  id: string;
  name: string;
  detail: string;
}

export interface EditorUiCallbacks {
  onSelectCategory: (category: string) => void;
  onSelectAsset: (id: string) => void;
  onSearch: (query: string) => void;
  onAction: (action: EditorAction) => void;
  onPropChange: (change: PropChange) => void;
}

export type EditorAction =
  | 'save'
  | 'load'
  | 'export'
  | 'import'
  | 'clear'
  | 'duplicate'
  | 'delete'
  | 'undo'
  | 'redo'
  | 'toggleSnap'
  | 'focus'
  | 'play';

export interface PropChange {
  field: 'scale' | 'rotation' | 'blocks' | 'opaque' | 'pickup' | 'item';
  value: number | boolean | string;
}

/** Categories always listed first, in this order, before any others. */
const CATEGORY_ORDER = ['building', 'nature', 'prop', 'weapon', 'shield', 'pickup', 'creature', 'unit'];

export class EditorUi {
  readonly root: HTMLDivElement;

  private readonly cb: EditorUiCallbacks;
  private readonly categoryBar: HTMLDivElement;
  private readonly searchInput: HTMLInputElement;
  private readonly list: HTMLDivElement;
  private readonly inspector: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly snapButton: HTMLButtonElement;

  constructor(parent: HTMLElement, cb: EditorUiCallbacks) {
    this.cb = cb;

    this.root = el('div', 'editor');
    this.root.style.display = 'none';

    // --- toolbar ----------------------------------------------------------
    const toolbar = el('div', 'editor-toolbar');
    const title = el('div', 'editor-title');
    title.textContent = 'EDITOR';
    toolbar.appendChild(title);

    const actions: Array<[EditorAction, string, string]> = [
      ['save', 'Save', 'Save to this browser'],
      ['load', 'Load', 'Load from this browser'],
      ['export', 'Export', 'Download a scene file'],
      ['import', 'Import', 'Open a scene file'],
      ['undo', 'Undo', 'Undo (Ctrl+Z)'],
      ['redo', 'Redo', 'Redo (Ctrl+Y)'],
      ['clear', 'Clear', 'Remove every placed prop'],
      ['play', 'Play', 'Leave the editor (F2)'],
    ];
    for (const [action, label, tip] of actions) {
      const b = el('button', 'editor-btn') as HTMLButtonElement;
      b.textContent = label;
      b.title = tip;
      b.onclick = () => this.cb.onAction(action);
      toolbar.appendChild(b);
    }

    this.snapButton = el('button', 'editor-btn') as HTMLButtonElement;
    this.snapButton.onclick = () => this.cb.onAction('toggleSnap');
    toolbar.appendChild(this.snapButton);
    this.root.appendChild(toolbar);

    // --- palette ----------------------------------------------------------
    const palette = el('div', 'editor-palette');

    this.categoryBar = el('div', 'editor-categories');
    palette.appendChild(this.categoryBar);

    this.searchInput = el('input', 'editor-search') as HTMLInputElement;
    this.searchInput.type = 'search';
    this.searchInput.placeholder = 'Search assets';
    this.searchInput.oninput = () => this.cb.onSearch(this.searchInput.value);
    palette.appendChild(this.searchInput);

    this.list = el('div', 'editor-list');
    palette.appendChild(this.list);

    this.root.appendChild(palette);

    // --- inspector --------------------------------------------------------
    this.inspector = el('div', 'editor-inspector');
    this.root.appendChild(this.inspector);

    this.status = el('div', 'editor-status');
    this.root.appendChild(this.status);

    parent.appendChild(this.root);
  }

  setVisible(visible: boolean): void {
    this.root.style.display = visible ? '' : 'none';
  }

  /** True while the user is typing, so the editor can ignore hotkeys. */
  get typing(): boolean {
    return document.activeElement === this.searchInput;
  }

  setCategories(categories: string[], active: string): void {
    this.categoryBar.textContent = '';
    const ordered = [...categories].sort((a, b) => {
      const ia = CATEGORY_ORDER.indexOf(a);
      const ib = CATEGORY_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    });
    for (const c of ordered) {
      const b = el('button', 'editor-cat' + (c === active ? ' active' : '')) as HTMLButtonElement;
      b.textContent = c;
      b.onclick = () => this.cb.onSelectCategory(c);
      this.categoryBar.appendChild(b);
    }
  }

  setItems(items: PaletteItem[], activeId: string): void {
    this.list.textContent = '';
    if (items.length === 0) {
      const empty = el('div', 'editor-empty');
      empty.textContent = 'No assets. Generate a pack, or check /assets/pack/manifest.json.';
      this.list.appendChild(empty);
      return;
    }
    for (const item of items) {
      const row = el('div', 'editor-item' + (item.id === activeId ? ' active' : ''));
      const name = el('span', 'editor-item-name');
      name.textContent = item.name;
      const detail = el('span', 'editor-item-detail');
      detail.textContent = item.detail;
      row.append(name, detail);
      row.onclick = () => this.cb.onSelectAsset(item.id);
      this.list.appendChild(row);
    }
  }

  setSnap(size: number): void {
    this.snapButton.textContent = size > 0 ? `Snap ${size}` : 'Snap off';
    this.snapButton.classList.toggle('active', size > 0);
  }

  setStatus(text: string): void {
    this.status.textContent = text;
  }

  /** Rebuilds the inspector for the selected prop, or clears it. */
  setSelection(prop: Prop | null, assetName: string): void {
    this.inspector.textContent = '';
    if (!prop) {
      const hint = el('div', 'editor-empty');
      hint.textContent = 'Nothing selected. Click a placed object to edit it.';
      this.inspector.appendChild(hint);
      return;
    }

    const head = el('div', 'editor-inspector-head');
    head.textContent = assetName;
    this.inspector.appendChild(head);

    const pos = el('div', 'editor-field-readonly');
    pos.textContent = `x ${prop.x.toFixed(2)}   y ${prop.y.toFixed(2)}`;
    this.inspector.appendChild(pos);

    this.inspector.appendChild(
      slider('Rotation', prop.rotation, -Math.PI, Math.PI, 0.01, (v) =>
        this.cb.onPropChange({ field: 'rotation', value: v }),
      ),
    );
    this.inspector.appendChild(
      slider('Scale', prop.scale, 0.15, 6, 0.01, (v) => this.cb.onPropChange({ field: 'scale', value: v })),
    );

    const flags = el('div', 'editor-flags');
    flags.appendChild(
      checkbox('Blocks movement', (prop.flags & PropFlag.Blocks) !== 0, (v) =>
        this.cb.onPropChange({ field: 'blocks', value: v }),
      ),
    );
    flags.appendChild(
      checkbox('Blocks vision', (prop.flags & PropFlag.Opaque) !== 0, (v) =>
        this.cb.onPropChange({ field: 'opaque', value: v }),
      ),
    );
    flags.appendChild(
      checkbox('Pickup', (prop.flags & PropFlag.Pickup) !== 0, (v) =>
        this.cb.onPropChange({ field: 'pickup', value: v }),
      ),
    );
    this.inspector.appendChild(flags);

    const row = el('div', 'editor-row');
    for (const [action, label] of [
      ['duplicate', 'Duplicate'],
      ['focus', 'Focus'],
      ['delete', 'Delete'],
    ] as Array<[EditorAction, string]>) {
      const b = el('button', 'editor-btn' + (action === 'delete' ? ' danger' : '')) as HTMLButtonElement;
      b.textContent = label;
      b.onclick = () => this.cb.onAction(action);
      row.appendChild(b);
    }
    this.inspector.appendChild(row);
  }

  blurSearch(): void {
    this.searchInput.blur();
  }
}

// --- small DOM helpers ----------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function slider(
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  onInput: (v: number) => void,
): HTMLDivElement {
  const wrap = el('div', 'editor-field');
  const name = el('label', 'editor-field-label');
  const readout = el('span', 'editor-field-value');
  readout.textContent = value.toFixed(2);
  name.textContent = label;
  name.appendChild(readout);

  const input = el('input', 'editor-slider') as HTMLInputElement;
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.oninput = () => {
    const v = Number(input.value);
    readout.textContent = v.toFixed(2);
    onInput(v);
  };

  wrap.append(name, input);
  return wrap;
}

function checkbox(label: string, checked: boolean, onChange: (v: boolean) => void): HTMLLabelElement {
  const wrap = el('label', 'editor-check');
  const input = el('input', '') as HTMLInputElement;
  input.type = 'checkbox';
  input.checked = checked;
  input.onchange = () => onChange(input.checked);
  const text = document.createElement('span');
  text.textContent = label;
  wrap.append(input, text);
  return wrap;
}

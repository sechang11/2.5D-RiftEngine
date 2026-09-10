/**
 * Raw input capture.
 *
 * Keys are tracked by `event.code`, not `event.key`, so bindings are physical
 * positions on the keyboard. QWER stays where it is on an AZERTY or Dvorak
 * layout, which is the whole point of those bindings.
 *
 * Edge-triggered sets are cleared once per frame by `endFrame`, so consumers
 * can ask "was this pressed this frame" without subscribing to events.
 */

export const enum MouseButton {
  Left = 0,
  Middle = 1,
  Right = 2,
}

export class InputState {
  /** Codes currently held. */
  readonly held = new Set<string>();
  /** Codes that went down this frame. */
  readonly pressed = new Set<string>();
  /** Codes that came up this frame. */
  readonly released = new Set<string>();

  readonly buttonsHeld = new Set<number>();
  readonly buttonsPressed = new Set<number>();
  readonly buttonsReleased = new Set<number>();

  /** Cursor position in CSS pixels relative to the viewport element. */
  mouseX = 0;
  mouseY = 0;
  /** True while the cursor is inside the viewport. */
  mouseInside = false;
  /** Accumulated wheel notches this frame. Positive is zoom out. */
  wheel = 0;

  private readonly listeners: Array<() => void> = [];

  constructor(element: HTMLElement) {
    element.tabIndex = 0;

    const onKeyDown = (e: KeyboardEvent) => {
      // Let the browser keep its own shortcuts.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const code = physicalCode(e);
      if (!code) return;
      if (!this.held.has(code)) this.pressed.add(code);
      this.held.add(code);
      // Arrows and space scroll the page; the game needs them.
      if (SWALLOWED.has(code)) e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const code = physicalCode(e);
      if (!code) return;
      this.held.delete(code);
      this.released.add(code);
    };
    // Releasing focus mid-keypress would otherwise leave a key stuck down.
    const onBlur = () => {
      this.held.clear();
      this.buttonsHeld.clear();
    };

    const onMouseMove = (e: MouseEvent) => {
      const rect = element.getBoundingClientRect();
      this.mouseX = e.clientX - rect.left;
      this.mouseY = e.clientY - rect.top;
      this.mouseInside =
        this.mouseX >= 0 && this.mouseY >= 0 && this.mouseX <= rect.width && this.mouseY <= rect.height;
    };
    const onMouseDown = (e: MouseEvent) => {
      element.focus();
      if (!this.buttonsHeld.has(e.button)) this.buttonsPressed.add(e.button);
      this.buttonsHeld.add(e.button);
      e.preventDefault();
    };
    const onMouseUp = (e: MouseEvent) => {
      this.buttonsHeld.delete(e.button);
      this.buttonsReleased.add(e.button);
    };
    const onWheel = (e: WheelEvent) => {
      this.wheel += Math.sign(e.deltaY);
      e.preventDefault();
    };
    const onContextMenu = (e: MouseEvent) => e.preventDefault();
    const onLeave = () => {
      this.mouseInside = false;
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    element.addEventListener('mousemove', onMouseMove);
    element.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    element.addEventListener('wheel', onWheel, { passive: false });
    element.addEventListener('contextmenu', onContextMenu);
    element.addEventListener('mouseleave', onLeave);

    this.listeners.push(
      () => window.removeEventListener('keydown', onKeyDown),
      () => window.removeEventListener('keyup', onKeyUp),
      () => window.removeEventListener('blur', onBlur),
      () => element.removeEventListener('mousemove', onMouseMove),
      () => element.removeEventListener('mousedown', onMouseDown),
      () => window.removeEventListener('mouseup', onMouseUp),
      () => element.removeEventListener('wheel', onWheel),
      () => element.removeEventListener('contextmenu', onContextMenu),
      () => element.removeEventListener('mouseleave', onLeave),
    );
  }

  isHeld(code: string): boolean {
    return this.held.has(code);
  }

  wasPressed(code: string): boolean {
    return this.pressed.has(code);
  }

  wasReleased(code: string): boolean {
    return this.released.has(code);
  }

  isButtonHeld(button: MouseButton): boolean {
    return this.buttonsHeld.has(button);
  }

  wasButtonPressed(button: MouseButton): boolean {
    return this.buttonsPressed.has(button);
  }

  wasButtonReleased(button: MouseButton): boolean {
    return this.buttonsReleased.has(button);
  }

  /** Clears edge-triggered state. Call once at the end of every frame. */
  endFrame(): void {
    this.pressed.clear();
    this.released.clear();
    this.buttonsPressed.clear();
    this.buttonsReleased.clear();
    this.wheel = 0;
  }

  dispose(): void {
    for (const off of this.listeners) off();
    this.listeners.length = 0;
  }
}

const SWALLOWED = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
  'Tab',
  'Backquote',
]);

/** Printable characters that have their own code name rather than KeyX. */
const PUNCTUATION_CODES: Record<string, string> = {
  ' ': 'Space',
  '`': 'Backquote',
  '~': 'Backquote',
  '[': 'BracketLeft',
  '{': 'BracketLeft',
  ']': 'BracketRight',
  '}': 'BracketRight',
  '-': 'Minus',
  '=': 'Equal',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  ';': 'Semicolon',
  "'": 'Quote',
  '\\': 'Backslash',
};

/**
 * Resolves a key event to a physical key code.
 *
 * `event.code` is the right answer and is what real keyboards provide. Some
 * event sources do not fill it in: on-screen keyboards, a few remote-desktop
 * and accessibility stacks, and synthetic events from automation. Falling back
 * to `event.key` keeps the game playable from those, at the cost of being
 * layout-dependent in exactly the cases where nothing better is available.
 */
function physicalCode(e: KeyboardEvent): string {
  if (e.code) return e.code;
  const key = e.key;
  if (!key) return '';
  if (key.length === 1) {
    const upper = key.toUpperCase();
    if (upper >= 'A' && upper <= 'Z') return `Key${upper}`;
    if (key >= '0' && key <= '9') return `Digit${key}`;
    return PUNCTUATION_CODES[key] ?? '';
  }
  // Named keys ("ArrowUp", "Escape", "Tab") already match their code.
  return key;
}

import type { ClientMessage, KnobState, TouchContact } from './protocol';

const MAX_CONTACTS = 2;
const KNOB_FLICK = 127;
/** Horizontal scroll, in pixels, a two-finger trackpad swipe must cover before it pages CarPlay. */
const SWIPE_THRESHOLD = 40;
/** Quiet time that ends a trackpad gesture, including its inertial scroll tail. */
const SWIPE_IDLE_MS = 250;
/** No human swipes twice this fast; anything sooner is the same gesture's lift-off and inertia. */
const SWIPE_MIN_GAP_MS = 250;
/** Fraction of the screen width the synthesized finger travels. */
const SWIPE_DISTANCE = 0.4;
const SWIPE_STEPS = 6;
const SWIPE_STEP_MS = 16;
/** Pointer id for the synthesized swipe contact; browsers never assign negative ids. */
const SWIPE_POINTER_ID = -1;

interface ActivePointer {
  slot: number;
  x: number;
  y: number;
  down: boolean;
  /** Whether the phone has seen this contact's current down/up state. */
  sent: boolean;
}

const emptyKnob = (overrides: Partial<KnobState> = {}): KnobState => ({
  select: false,
  home: false,
  back: false,
  x: 0,
  y: 0,
  wheel: 0,
  ...overrides,
});

/** Maps browser pointer/keyboard input to CarPlay touch and knob HID messages. */
export class InputController {
  private readonly pointers = new Map<number, ActivePointer>();
  private pendingFlush = 0;
  private swipeAccumX = 0;
  private swipeAccumY = 0;
  /** A swipe already fired for the current trackpad gesture; ignore its tail until a new one starts. */
  private swipeLocked = false;
  /** Speed profile of the locked gesture, used to spot a new swipe inside its inertia. */
  private swipeLockSign = 0;
  private swipeLockTime = 0;
  private swipePrevSpeed = 0;
  private swipeTrough = 0;
  private swipeDecayRun = 0;
  private swipeRise = 0;
  private swipeReverseCount = 0;
  private swipeReverseSum = 0;
  private swipeIdleTimer = 0;
  private swipeStepTimer = 0;

  constructor(
    private readonly surface: HTMLElement,
    private readonly send: (message: ClientMessage) => void,
  ) {}

  attach(): void {
    const surface = this.surface;
    surface.style.touchAction = 'none';
    surface.addEventListener('pointerdown', this.onPointerDown, { passive: false });
    surface.addEventListener('pointermove', this.onPointerMove, { passive: false });
    surface.addEventListener('pointerup', this.onPointerUp, { passive: false });
    surface.addEventListener('pointercancel', this.onPointerUp, { passive: false });
    surface.addEventListener('pointerleave', this.onPointerUp, { passive: false });
    surface.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('keydown', this.onKeyDown);
  }

  detach(): void {
    const surface = this.surface;
    surface.removeEventListener('pointerdown', this.onPointerDown);
    surface.removeEventListener('pointermove', this.onPointerMove);
    surface.removeEventListener('pointerup', this.onPointerUp);
    surface.removeEventListener('pointercancel', this.onPointerUp);
    surface.removeEventListener('pointerleave', this.onPointerUp);
    surface.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('keydown', this.onKeyDown);
    window.clearTimeout(this.swipeIdleTimer);
    window.clearTimeout(this.swipeStepTimer);
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    event.preventDefault();
    // Same pointer pressed again before its release went out: send that release first.
    if (this.pointers.get(event.pointerId)?.down === false) this.flush();
    if (this.pointers.size >= MAX_CONTACTS) return;
    this.surface.focus({ preventScroll: true });
    this.surface.setPointerCapture(event.pointerId);
    this.pointers.set(event.pointerId, {
      slot: this.nextSlot(),
      x: this.normalizeX(event.clientX),
      y: this.normalizeY(event.clientY),
      down: true,
      sent: false,
    });
    this.scheduleFlush();
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const pointer = this.pointers.get(event.pointerId);
    if (!pointer || !pointer.down) return;
    event.preventDefault();
    pointer.x = this.normalizeX(event.clientX);
    pointer.y = this.normalizeY(event.clientY);
    this.scheduleFlush();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    const pointer = this.pointers.get(event.pointerId);
    if (!pointer || !pointer.down) return;
    event.preventDefault();
    // A tap shorter than one animation frame would otherwise coalesce into a lone release and the
    // phone would never see the press: deliver the press first.
    if (!pointer.sent) this.flush();
    // Lift off where the finger was. Dropping the contact would report the release at (0, 0), which
    // iOS treats as dragging off the control and cancels the tap.
    pointer.down = false;
    pointer.sent = false;
    this.scheduleFlush();
  };

  /** Turns a two-finger horizontal trackpad swipe into a one-finger CarPlay swipe at the cursor. */
  private readonly onWheel = (event: WheelEvent): void => {
    // Pinch-zoom arrives as ctrl+wheel; leave it to the browser.
    if (event.ctrlKey) return;
    // Chrome only lets the first wheel event of a gesture be cancelled, and that event is often tiny or
    // mostly vertical. Claim every one so the browser never latches the swipe as history back/forward.
    event.preventDefault();
    if (this.surface.inert) return;
    window.clearTimeout(this.swipeIdleTimer);
    this.swipeIdleTimer = window.setTimeout(() => this.resetSwipe(), SWIPE_IDLE_MS);
    const scale = event.deltaMode === 0 ? 1 : 16;
    const deltaX = event.deltaX * scale;
    const deltaY = event.deltaY * scale;
    if (this.swipeLocked) {
      if (!this.startsNewSwipe(deltaX, event.timeStamp)) return;
      this.resetSwipe();
    }
    this.swipeAccumX += deltaX;
    this.swipeAccumY += deltaY;
    if (Math.abs(this.swipeAccumX) < SWIPE_THRESHOLD || Math.abs(this.swipeAccumX) <= Math.abs(this.swipeAccumY) || this.pointers.size > 0) return;
    this.swipeLocked = true;
    this.swipeLockSign = Math.sign(this.swipeAccumX);
    this.swipeLockTime = event.timeStamp;
    this.swipePrevSpeed = Math.abs(deltaX);
    this.swipeTrough = this.swipePrevSpeed;
    this.swipeDecayRun = 0;
    this.swipeRise = 0;
    this.swipeReverseCount = 0;
    this.swipeReverseSum = 0;
    // Scrolling content right (positive delta) means dragging it left.
    const direction = this.swipeAccumX > 0 ? -1 : 1;
    const half = SWIPE_DISTANCE / 2;
    const center = Math.min(1 - half, Math.max(half, this.normalizeX(event.clientX)));
    this.synthesizeSwipe(center - direction * half, center + direction * half, this.normalizeY(event.clientY));
  };

  /**
   * macOS keeps streaming inertial wheel events for up to a second after the fingers lift, with no
   * phase information exposed to the page, and finger speed wobbles while the fingers are still down.
   * Inertia decays smoothly in the original direction, so only a clear new pattern counts as another
   * swipe: a sustained reversal, or a steady decay followed by two accelerating events.
   */
  private startsNewSwipe(deltaX: number, time: number): boolean {
    const speed = Math.abs(deltaX);
    if (speed === 0) return false;
    if (Math.sign(deltaX) !== this.swipeLockSign) {
      this.swipeReverseCount += 1;
      this.swipeReverseSum += speed;
      this.swipeDecayRun = 0;
      this.swipeRise = 0;
      return this.swipeReverseCount >= 2 && this.swipeReverseSum >= 12 && time - this.swipeLockTime >= SWIPE_MIN_GAP_MS;
    }
    this.swipeReverseCount = 0;
    this.swipeReverseSum = 0;
    if (speed <= this.swipePrevSpeed + 1) {
      this.swipeTrough = this.swipeDecayRun > 0 ? Math.min(this.swipeTrough, speed) : speed;
      this.swipeDecayRun += 1;
      this.swipeRise = 0;
    } else if (this.swipeDecayRun >= 4) {
      this.swipeRise += 1;
    } else {
      // Finger speed wobble, not a decay-then-surge: start watching for a decay again.
      this.swipeDecayRun = 0;
      this.swipeRise = 0;
    }
    this.swipePrevSpeed = speed;
    return this.swipeRise >= 2 && speed > this.swipeTrough * 2 + 6 && time - this.swipeLockTime >= SWIPE_MIN_GAP_MS;
  }

  private resetSwipe(): void {
    this.swipeAccumX = 0;
    this.swipeAccumY = 0;
    this.swipeLocked = false;
  }

  private synthesizeSwipe(fromX: number, toX: number, y: number): void {
    const contact: ActivePointer = { slot: this.nextSlot(), x: fromX, y, down: true, sent: false };
    this.pointers.set(SWIPE_POINTER_ID, contact);
    this.flush();
    let step = 0;
    const advance = () => {
      step += 1;
      contact.x = fromX + ((toX - fromX) * step) / SWIPE_STEPS;
      if (step >= SWIPE_STEPS) {
        contact.down = false;
        this.swipeStepTimer = 0;
      } else {
        this.swipeStepTimer = window.setTimeout(advance, SWIPE_STEP_MS);
      }
      this.flush();
    };
    this.swipeStepTimer = window.setTimeout(advance, SWIPE_STEP_MS);
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.surface.inert || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    if (document.querySelector('dialog[open]')) return;
    if (event.target instanceof Element && (event.target.closest('input, select, textarea, [contenteditable="true"]') || ((event.key === 'Enter' || event.key === ' ') && event.target.closest('button, a')))) return;
    const knob = (overrides: Partial<KnobState>) => {
      event.preventDefault();
      this.send({ type: 'knob', knob: emptyKnob(overrides) });
    };
    switch (event.key) {
      case 'ArrowUp':
        knob({ y: -KNOB_FLICK });
        break;
      case 'ArrowDown':
        knob({ y: KNOB_FLICK });
        break;
      case 'ArrowLeft':
        knob({ x: -KNOB_FLICK });
        break;
      case 'ArrowRight':
        knob({ x: KNOB_FLICK });
        break;
      case 'Enter':
        knob({ select: true });
        break;
      case 'Escape':
      case 'Backspace':
        knob({ back: true });
        break;
      case 'Home':
        knob({ home: true });
        break;
      case 's':
        event.preventDefault();
        this.send({ type: 'siri' });
        break;
      case ' ':
        event.preventDefault();
        this.send({ type: 'media', media: 3 });
        break;
      case 'MediaPlayPause':
        event.preventDefault();
        this.send({ type: 'media', media: 3 });
        break;
      case 'MediaTrackNext':
        event.preventDefault();
        this.send({ type: 'media', media: 4 });
        break;
      case 'MediaTrackPrevious':
        event.preventDefault();
        this.send({ type: 'media', media: 5 });
        break;
      default:
        break;
    }
  };

  private nextSlot(): number {
    const used = new Set(Array.from(this.pointers.values(), (pointer) => pointer.slot));
    for (let slot = 0; slot < MAX_CONTACTS; slot += 1) {
      if (!used.has(slot)) return slot;
    }
    return 0;
  }

  private scheduleFlush(): void {
    if (this.pendingFlush !== 0) return;
    this.pendingFlush = window.requestAnimationFrame(() => {
      this.pendingFlush = 0;
      this.flush();
    });
  }

  private flush(): void {
    const contacts: TouchContact[] = [];
    for (const [pointerId, pointer] of this.pointers) {
      contacts.push({ id: pointer.slot, x: pointer.x, y: pointer.y, down: pointer.down });
      pointer.sent = true;
      if (!pointer.down) this.pointers.delete(pointerId);
    }
    this.send({ type: 'touch', contacts });
  }

  private normalizeX(clientX: number): number {
    const rect = this.surface.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return clamp01((clientX - rect.left) / rect.width);
  }

  private normalizeY(clientY: number): number {
    const rect = this.surface.getBoundingClientRect();
    if (rect.height <= 0) return 0;
    return clamp01((clientY - rect.top) / rect.height);
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

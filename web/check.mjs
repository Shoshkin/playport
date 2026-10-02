import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Exercise the real controller with just the DOM surface it uses; no browser or phone needed.
const source = readFileSync(new URL('./src/input.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { InputController } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const listeners = new Map();
const frames = [];
const timers = new Map();
let nextTimer = 1;
const runTimers = (maxDelay = Infinity) => {
  for (let due; (due = [...timers].find(([, t]) => t.delay <= maxDelay));) { timers.delete(due[0]); due[1].handler(); }
};
const runSwipeSteps = () => runTimers(100);
const messages = [];
let modalOpen = false;
let rect = { left: 100, top: 50, width: 400, height: 225 };
class Element {
  constructor(tag = 'canvas') { this.tag = tag; }
  closest(selector) { return selector.split(',').map((s) => s.trim()).includes(this.tag) ? this : null; }
}
globalThis.Element = Element;
globalThis.document = { querySelector: () => modalOpen ? {} : null };
globalThis.window = {
  addEventListener: (name, handler) => listeners.set(name, handler),
  removeEventListener: (name) => listeners.delete(name),
  requestAnimationFrame: (handler) => { frames.push(handler); return frames.length; },
  setTimeout: (handler, delay = 0) => { timers.set(nextTimer, { handler, delay }); return nextTimer++; },
  clearTimeout: (id) => timers.delete(id),
};
const surface = Object.assign(new Element(), {
  inert: false, style: {}, focus() {}, setPointerCapture() {},
  addEventListener: window.addEventListener, removeEventListener: window.removeEventListener,
  getBoundingClientRect: () => rect,
});
const controller = new InputController(surface, (message) => messages.push(message));
controller.attach();
const key = (value, target = surface, extra = {}) => listeners.get('keydown')({ key: value, target, preventDefault() {}, ...extra });
const flush = () => { for (const frame of frames.splice(0)) frame(); };

key('ArrowRight');
assert.equal(messages.pop().knob.x, 127);
key('Enter');
assert.equal(messages.pop().knob.select, true);
key(' ');
assert.deepEqual(messages.pop(), { type: 'media', media: 3 });
surface.inert = true;
key('s');
surface.inert = false;
modalOpen = true;
key('Escape');
modalOpen = false;
for (const tag of ['input', 'select', 'textarea', '[contenteditable="true"]']) key('ArrowUp', new Element(tag));
key('Enter', new Element('button'));
key(' ', new Element('a'));
key('s', surface, { ctrlKey: true });
key('s', surface, { defaultPrevented: true });
assert.equal(messages.length, 0, 'Settings, native controls, browser shortcuts, and disconnected screens must not send CarPlay commands');
key('ArrowLeft', new Element('button'));
assert.equal(messages.pop().knob.x, -127, 'Navigation still works after clicking a toolbar button');

const pointer = (id, x, y) => ({ pointerId: id, clientX: x, clientY: y, preventDefault() {} });
listeners.get('pointerdown')(pointer(1, 300, 162.5));
flush();
assert.deepEqual(messages.pop().contacts, [{ id: 0, x: .5, y: .5, down: true }]);
rect = { left: 100, top: 50, width: 225, height: 400 };
listeners.get('pointermove')(pointer(1, 212.5, 250));
listeners.get('pointerdown')(pointer(2, 500, 0));
listeners.get('pointerdown')(pointer(3, 200, 100));
flush();
assert.deepEqual(messages.pop().contacts, [{ id: 0, x: .5, y: .5, down: true }, { id: 1, x: 1, y: 0, down: true }]);
listeners.get('pointerup')(pointer(1, 0, 0));
listeners.get('pointercancel')(pointer(2, 0, 0));
flush();
assert.deepEqual(messages.pop().contacts, [{ id: 0, x: .5, y: .5, down: false }, { id: 1, x: 1, y: 0, down: false }], 'Release every contact where it was, including cancelled touches');
messages.length = 0;
listeners.get('pointerdown')(pointer(5, 212.5, 250));
flush();
assert.deepEqual(messages.pop().contacts, [{ id: 0, x: .5, y: .5, down: true }], 'Released contacts are sent once and free their slot');
listeners.get('pointerup')(pointer(5, 0, 0));
flush();
messages.length = 0;
listeners.get('pointerdown')(pointer(4, 212.5, 250));
listeners.get('pointerup')(pointer(4, 0, 0));
flush();
assert.deepEqual(messages, [{ type: 'touch', contacts: [{ id: 0, x: .5, y: .5, down: true }] }, { type: 'touch', contacts: [{ id: 0, x: .5, y: .5, down: false }] }], 'A tap inside one frame still presses before releasing');
messages.length = 0;

rect = { left: 100, top: 50, width: 400, height: 225 };
let prevented = 0;
let clock = 0;
const wheel = (deltaX, deltaY = 0) => listeners.get('wheel')({ deltaX, deltaY, deltaMode: 0, timeStamp: clock += 16, clientX: 300, clientY: 162.5, ctrlKey: false, preventDefault() { prevented += 1; } });
wheel(0, 30);
assert.equal(prevented, 1, 'Even a vertical first event is claimed so Chrome cannot latch the gesture');
assert.equal(messages.length, 0, 'Vertical scrolling does not swipe');
runTimers();
wheel(25);
assert.equal(messages.length, 0, 'A small nudge does not swipe');
wheel(25);
wheel(80);
assert.equal(prevented, 4, 'Horizontal swipes never reach browser back/forward navigation');
const swipe = messages.splice(0).map((m) => m.contacts[0]);
assert.deepEqual(swipe[0], { id: 0, x: .7, y: .5, down: true });
wheel(-80);
assert.equal(messages.length, 0, 'One trackpad gesture (and its inertia) pages only once');
runTimers();
const rest = messages.splice(0).map((m) => m.contacts[0]);
assert.equal(rest.length, 6);
assert.ok(Math.abs(rest.at(-1).x - .3) < 1e-9 && rest.at(-1).down === false, 'Swiping fingers left drags CarPlay left and lifts off');
wheel(-60);
assert.deepEqual(messages.pop().contacts, [{ id: 0, x: .3, y: .5, down: true }], 'The next gesture swipes the other way');
runTimers();
messages.length = 0;
// A real gesture: wobbling fingers, a lift-off bump, then decaying inertia; then a second swipe.
const gesture = [10, 20, 30, 35, 22, 30, 18, 12, 20, 26, 22, 18, 15, 12, 10, 8, 6, 5, 4, 3, 3, 2, 2, 1];
for (const dx of gesture) wheel(dx);
assert.equal(messages.filter((m) => m.contacts.some((c) => c.down && c.x === .7)).length, 1, 'Wobble, lift-off, and inertia page once');
runSwipeSteps();
messages.length = 0;
for (const dx of [6, 14, 25, 35]) wheel(dx);
assert.deepEqual(messages.pop().contacts, [{ id: 0, x: .7, y: .5, down: true }], 'A second swipe during the first one\'s inertia still pages');
runSwipeSteps();
messages.length = 0;
for (const dx of gesture.slice(0, 6)) wheel(dx);
for (const dx of [-2, 4]) wheel(dx);
assert.equal(messages.filter((m) => m.contacts.some((c) => c.down && c.x === .3)).length, 0, 'A backward twitch at lift-off is not a reverse swipe');
for (const dx of gesture.slice(10)) wheel(dx);
runSwipeSteps();
messages.length = 0;
for (const dx of [-3, -10, -30]) wheel(dx);
assert.equal(messages.filter((m) => m.contacts.some((c) => c.down && c.x === .3)).length, 1, 'Reversing direction mid-inertia swipes back');
runTimers();
messages.length = 0;
controller.detach();
assert.equal(listeners.size, 0);
console.log('Viewer input check passed: keyboard isolation, native controls, portrait/landscape coordinates, multi-touch, release, and trackpad swipes.');

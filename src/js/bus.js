// Tiny app-wide event bus so modules don't import each other in circles.
const target = new EventTarget();

export function emit(name, detail) {
    target.dispatchEvent(new CustomEvent(name, { detail }));
}

export function on(name, handler) {
    target.addEventListener(name, (e) => handler(e.detail));
}

export function once(name, handler) {
    target.addEventListener(name, (e) => handler(e.detail), { once: true });
}

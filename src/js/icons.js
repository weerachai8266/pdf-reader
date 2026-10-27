// <svg class="icon"><use href="img/icons.svg#i-NAME"></use></svg> for
// elements built in JS (the same sprite the toolbar uses).

const SVG_NS = 'http://www.w3.org/2000/svg';

export function icon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `img/icons.svg#i-${name}`);
    svg.append(use);
    return svg;
}

export function iconHtml(name) {
    return `<svg class="icon" aria-hidden="true"><use href="img/icons.svg#i-${name}"></use></svg>`;
}

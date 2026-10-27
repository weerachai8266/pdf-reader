// Minimal pdf.js "link service" for the annotation layer: internal links
// jump to the right page (even after reordering/merging), external links
// open in the default browser (main.js routes them via shell.openExternal).

import { state } from './docstate.js';
import { scrollToIndex, currentPageIndex } from './viewer.js';

const services = new Map(); // srcId -> link service

export function linkServiceFor(srcId) {
    if (!services.has(srcId)) services.set(srcId, createLinkService(srcId));
    return services.get(srcId);
}

export function resetLinkServices() {
    services.clear();
}

function createLinkService(srcId) {
    const pdf = () => state.sources.get(srcId)?.pdf;

    const goToSourcePage = (pageIndex) => {
        const idx = state.pages.findIndex((p) => p.srcId === srcId && p.index === pageIndex);
        if (idx >= 0) scrollToIndex(idx);
    };

    return {
        externalLinkEnabled: true,
        eventBus: null,
        get pagesCount() {
            return state.pages.length;
        },
        get page() {
            return currentPageIndex() + 1;
        },
        addLinkAttributes(link, url) {
            if (!/^(https?:|mailto:)/i.test(url || '')) return;
            link.href = url;
            link.target = '_blank';
            link.rel = 'noopener noreferrer nofollow';
            link.title = url;
        },
        getDestinationHash() {
            return '#';
        },
        getAnchorUrl() {
            return '#';
        },
        async goToDestination(dest) {
            const doc = pdf();
            if (!doc) return;
            const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : await dest;
            if (!Array.isArray(explicit)) return;
            const [ref] = explicit;
            const pageIndex = Number.isInteger(ref) ? ref : await doc.getPageIndex(ref).catch(() => -1);
            if (pageIndex >= 0) goToSourcePage(pageIndex);
        },
        goToPage(pageNumber) {
            scrollToIndex(pageNumber - 1);
        },
        executeNamedAction(action) {
            const cur = currentPageIndex();
            const target = { NextPage: cur + 1, PrevPage: cur - 1, FirstPage: 0, LastPage: state.pages.length - 1 }[action];
            if (target !== undefined) scrollToIndex(target);
        },
        executeSetOCGState() {},
        getAttachmentContent() {
            return null;
        },
    };
}

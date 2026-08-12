import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { exportGeminiImages, getGeminiVisibleImageUrls, waitForGeminiImages } from './utils.js';

const CONVERSATION_URL = 'https://gemini.google.com/app/abc123';
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';

/**
 * Build a page whose evaluate runs the generated scripts against a JSDOM
 * conversation, with the generation state supplied per poll.
 */
function createPageMock({ generating = [false] } = {}) {
    const dom = new JSDOM('<main></main>', { url: CONVERSATION_URL, runScripts: 'outside-only' });
    let index = 0;
    return {
        dom,
        goto: vi.fn().mockResolvedValue(undefined),
        wait: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn((script) => {
            if (script === 'window.location.href') return Promise.resolve(CONVERSATION_URL);
            if (script.includes('stop response')) {
                const value = generating[Math.min(index, generating.length - 1)] ?? false;
                index += 1;
                return typeof value === 'boolean' ? Promise.resolve(value) : Promise.reject(new Error('probe failed'));
            }
            return Promise.resolve(dom.window.eval(script));
        }),
    };
}

function wrapEvaluate(page) {
    const original = page.evaluate;
    page.evaluate = vi.fn(async (script) => ({ session: 'site:gemini', data: await original(script) }));
    return page;
}

/** Mount an image whose decode state and layout box are controlled per case. */
function mountImage(dom, { src, naturalWidth, complete, box = 708 }) {
    dom.window.document.querySelector('main').innerHTML = `<img src="${src}" alt="AI generated">`;
    const img = dom.window.document.querySelector('main img');
    Object.defineProperty(img, 'complete', { value: complete });
    Object.defineProperty(img, 'naturalWidth', { value: naturalWidth });
    Object.defineProperty(img, 'naturalHeight', { value: naturalWidth });
    Object.defineProperty(img, 'width', { value: box });
    Object.defineProperty(img, 'height', { value: box });
    img.getBoundingClientRect = () => ({ width: box, height: box });
    return img;
}

/** Answer the in-page fetch with a blob of the given type. */
function stubFetch(dom, { type }) {
    dom.window.fetch = () => Promise.resolve({
        ok: true,
        blob: () => Promise.resolve({ type }),
    });
    dom.window.FileReader = class {
        readAsDataURL(blob) {
            this.result = blob.type === 'image/png' ? PNG_DATA_URL : 'data:text/html;base64,PGh0bWw+';
            this.onloadend?.();
        }
    };
}

describe('gemini image detection', () => {
    it('collects a blob: object URL (Gemini generated-image format) even while streaming', async () => {
        const page = createPageMock();
        mountImage(page.dom, { src: 'blob:https://gemini.google.com/pending', naturalWidth: 0, complete: false });

        // blob: 是 Gemini 新生成图的内存 object URL（瞬态，nw=0 正常），按 URL 特征收录；
        // 空/未解码的 blob 由 export 阶段的 data-URL 校验拒掉，不会存空白帧（#2245）
        await expect(getGeminiVisibleImageUrls(page)).resolves.toEqual(['blob:https://gemini.google.com/pending']);
    });

    it('collects a blob: object URL that reports no decodable bytes yet', async () => {
        const page = createPageMock();
        mountImage(page.dom, { src: 'blob:https://gemini.google.com/broken', naturalWidth: 0, complete: true });

        await expect(getGeminiVisibleImageUrls(page)).resolves.toEqual(['blob:https://gemini.google.com/broken']);
    });

    it('collects a blob: object URL that reports dimensions before finishing loading', async () => {
        const page = createPageMock();
        mountImage(page.dom, { src: 'blob:https://gemini.google.com/partial', naturalWidth: 1024, complete: false });

        await expect(getGeminiVisibleImageUrls(page)).resolves.toEqual(['blob:https://gemini.google.com/partial']);
    });

    it('accepts a decoded generated image', async () => {
        const page = createPageMock();
        mountImage(page.dom, { src: 'https://lh3.googleusercontent.com/generated.png', naturalWidth: 1024, complete: true });

        await expect(getGeminiVisibleImageUrls(page)).resolves.toEqual([
            'https://lh3.googleusercontent.com/generated.png',
        ]);
    });

    it('unwraps Browser Bridge envelopes before returning image URLs', async () => {
        const page = wrapEvaluate(createPageMock());
        mountImage(page.dom, { src: 'https://lh3.googleusercontent.com/generated.png', naturalWidth: 1024, complete: true });

        await expect(getGeminiVisibleImageUrls(page)).resolves.toEqual([
            'https://lh3.googleusercontent.com/generated.png',
        ]);
    });

    it('detects a hotlink-protected generated image (gg/) even at naturalWidth 0', async () => {
        const page = createPageMock();
        mountImage(page.dom, { src: 'https://lh3.googleusercontent.com/gg/ACRwjavi.png', naturalWidth: 0, complete: false });

        await expect(getGeminiVisibleImageUrls(page)).resolves.toEqual([
            'https://lh3.googleusercontent.com/gg/ACRwjavi.png',
        ]);
    });
});

describe('gemini image wait contract', () => {
    it('accepts the generated image even while the probe still reports generating', async () => {
        const page = createPageMock({ generating: [true] });
        mountImage(page.dom, { src: 'https://lh3.googleusercontent.com/mid.png', naturalWidth: 1024, complete: true });

        await expect(waitForGeminiImages(page, [], 9)).resolves.toEqual(['https://lh3.googleusercontent.com/mid.png']);
    });

    it('fails closed when the generation probe stops answering', async () => {
        const page = createPageMock({ generating: [true, 'unreadable'] });

        await expect(waitForGeminiImages(page, [], 9)).rejects.toMatchObject({ code: 'COMMAND_EXEC' });
    });

    it('does not accept a visible image when the first generation probe fails', async () => {
        const page = createPageMock({ generating: ['unreadable'] });
        mountImage(page.dom, { src: 'https://lh3.googleusercontent.com/unknown-state.png', naturalWidth: 1024, complete: true });

        await expect(waitForGeminiImages(page, [], 9)).rejects.toMatchObject({ code: 'COMMAND_EXEC' });
    });

    it('keeps the detected image even if the probe resumes reporting generating', async () => {
        const page = createPageMock({ generating: [false, true, true] });
        mountImage(page.dom, { src: 'https://lh3.googleusercontent.com/transient.png', naturalWidth: 1024, complete: true });

        await expect(waitForGeminiImages(page, [], 9)).resolves.toEqual(['https://lh3.googleusercontent.com/transient.png']);
    });

    it('returns the image once generation has stopped', async () => {
        const page = createPageMock({ generating: [false] });
        mountImage(page.dom, { src: 'https://lh3.googleusercontent.com/final.png', naturalWidth: 1024, complete: true });

        await expect(waitForGeminiImages(page, [], 9)).resolves.toEqual([
            'https://lh3.googleusercontent.com/final.png',
        ]);
    });

    it('unwraps Browser Bridge envelopes before reading the generation probe', async () => {
        const page = wrapEvaluate(createPageMock({ generating: [true] }));
        mountImage(page.dom, { src: 'https://lh3.googleusercontent.com/mid.png', naturalWidth: 1024, complete: true });

        // 若不解包信封，isGeminiGenerating 会因非 boolean 抛错；解包后才能扫描到图并返回
        await expect(waitForGeminiImages(page, [], 9)).resolves.toEqual(['https://lh3.googleusercontent.com/mid.png']);
    });

    it('resolves empty when generation finished without producing an image', async () => {
        const page = createPageMock({ generating: [false] });

        await expect(waitForGeminiImages(page, [], 9)).resolves.toEqual([]);
    });
});

describe('gemini image export', () => {
    it('exports an image whose blob carries an image type', async () => {
        const page = createPageMock();
        mountImage(page.dom, { src: 'blob:https://gemini.google.com/ok', naturalWidth: 1024, complete: true });
        stubFetch(page.dom, { type: 'image/png' });

        await expect(exportGeminiImages(page, ['blob:https://gemini.google.com/ok'])).resolves.toEqual([
            expect.objectContaining({ dataUrl: PNG_DATA_URL, mimeType: 'image/png' }),
        ]);
    });

    it('unwraps Browser Bridge envelopes before returning exported assets', async () => {
        const page = wrapEvaluate(createPageMock());
        mountImage(page.dom, { src: 'blob:https://gemini.google.com/ok', naturalWidth: 1024, complete: true });
        stubFetch(page.dom, { type: 'image/png' });

        await expect(exportGeminiImages(page, ['blob:https://gemini.google.com/ok'])).resolves.toEqual([
            expect.objectContaining({ dataUrl: PNG_DATA_URL, mimeType: 'image/png' }),
        ]);
    });

    it('fails closed when Browser Bridge returns malformed exported assets', async () => {
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            wait: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn((script) => {
                if (script === 'window.location.href')
                    return Promise.resolve(CONVERSATION_URL);
                return Promise.resolve({
                    session: 'site:gemini',
                    data: [{ dataUrl: PNG_DATA_URL, mimeType: 'image/png' }],
                });
            }),
        };

        await expect(exportGeminiImages(page, ['blob:https://gemini.google.com/bad'])).rejects.toMatchObject({ code: 'COMMAND_EXEC' });
    });

    it('drops a response that came back as a page instead of an image', async () => {
        const page = createPageMock();
        mountImage(page.dom, { src: 'blob:https://gemini.google.com/error', naturalWidth: 1024, complete: true });
        stubFetch(page.dom, { type: 'text/html' });

        await expect(exportGeminiImages(page, ['blob:https://gemini.google.com/error'])).resolves.toEqual([]);
    });

    it('does not redraw an image whose bytes never decoded', async () => {
        const page = createPageMock();
        mountImage(page.dom, { src: 'blob:https://gemini.google.com/blank', naturalWidth: 0, complete: false });
        page.dom.window.fetch = () => Promise.reject(new Error('CORS'));
        const drawImage = vi.fn();
        page.dom.window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage });
        page.dom.window.HTMLCanvasElement.prototype.toDataURL = () => PNG_DATA_URL;

        await expect(exportGeminiImages(page, ['blob:https://gemini.google.com/blank'])).resolves.toEqual([]);
        expect(drawImage).not.toHaveBeenCalled();
    });

    it('exports a hotlink-protected generated image via a new tab when in-page export fails', async () => {
        const page = createPageMock();
        mountImage(page.dom, { src: 'https://lh3.googleusercontent.com/gg/ACRwjavi.png', naturalWidth: 0, complete: false });
        page.dom.window.fetch = () => Promise.reject(new Error('CORS'));
        // 新 tab 导出路径
        page.getActivePage = vi.fn().mockReturnValue('tab-orig');
        page.newTab = vi.fn().mockResolvedValue('tab-new');
        page.selectTab = vi.fn().mockResolvedValue(undefined);
        page.closeTab = vi.fn().mockResolvedValue(undefined);
        page.sleep = vi.fn().mockResolvedValue(undefined);
        const baseEvaluate = page.evaluate;
        page.evaluate = vi.fn(async (script) => {
            // 新 tab 导出脚本（含 document.querySelector('img')）返回可导出的 data URL
            if (typeof script === 'string' && script.includes("document.querySelector('img')")) {
                return { dataUrl: PNG_DATA_URL, mimeType: 'image/png' };
            }
            return baseEvaluate(script);
        });

        await expect(exportGeminiImages(page, ['https://lh3.googleusercontent.com/gg/ACRwjavi.png'])).resolves.toEqual([
            expect.objectContaining({
                url: 'https://lh3.googleusercontent.com/gg/ACRwjavi.png',
                dataUrl: PNG_DATA_URL,
                mimeType: 'image/png',
            }),
        ]);
        expect(page.newTab).toHaveBeenCalledWith('https://lh3.googleusercontent.com/gg/ACRwjavi.png');
        expect(page.closeTab).toHaveBeenCalledWith('tab-new');
    });
});

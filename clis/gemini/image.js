import * as os from 'node:os';
import * as path from 'node:path';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { saveBase64ToFile } from '@jackwener/opencli/utils';
import { ArgumentError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { GEMINI_DOMAIN, exportGeminiImages, getGeminiVisibleImageUrls, sendGeminiMessage, startNewGeminiChat, waitForGeminiImages } from './utils.js';
function extFromMime(mime) {
    if (mime.includes('png'))
        return '.png';
    if (mime.includes('webp'))
        return '.webp';
    if (mime.includes('gif'))
        return '.gif';
    return '.jpg';
}
function normalizeBooleanFlag(value) {
    if (typeof value === 'boolean')
        return value;
    const normalized = String(value ?? '').trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}
function displayPath(filePath) {
    const home = os.homedir();
    return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
}
export function resolveOutputDir(value) {
    const raw = String(value || '').trim();
    if (!raw)
        return path.join(os.homedir(), 'tmp', 'gemini-images');
    if (raw === '~')
        return os.homedir();
    if (raw.startsWith('~/'))
        return path.join(os.homedir(), raw.slice(2));
    return path.resolve(raw);
}
function buildImagePrompt(prompt, options) {
    const extras = [];
    if (options.ratio)
        extras.push(`aspect ratio ${options.ratio}`);
    if (options.style)
        extras.push(`style ${options.style}`);
    if (extras.length === 0)
        return prompt;
    return `${prompt}

Image requirements: ${extras.join(', ')}.`;
}
function normalizeRatio(value) {
    const normalized = value.trim();
    const allowed = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']);
    return allowed.has(normalized) ? normalized : '1:1';
}
async function currentGeminiLink(page) {
    const url = await page.evaluate('window.location.href').catch(() => '');
    return typeof url === 'string' && url ? url : 'https://gemini.google.com/app';
}
export const imageCommand = cli({
    site: 'gemini',
    name: 'image',
    access: 'write',
    description: 'Generate images with Gemini web and save them locally',
    domain: GEMINI_DOMAIN,
    strategy: Strategy.COOKIE,
    browser: true,
    siteSession: 'persistent',
    navigateBefore: false,
    defaultFormat: 'plain',
    args: [
        { name: 'prompt', positional: true, required: true, help: 'Image prompt to send to Gemini' },
        { name: 'rt', default: '1:1', help: 'Ratio shorthand for aspect ratio (1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3)' },
        { name: 'st', default: '', help: 'Style shorthand, e.g. anime, icon, watercolor' },
        { name: 'op', default: '~/tmp/gemini-images', help: 'Output directory shorthand' },
        { name: 'sd', type: 'boolean', default: false, help: 'Skip download shorthand; only show Gemini page link' },
        { name: 'timeout', type: 'int', required: false, default: 240, help: 'Max seconds for the overall command (default: 240)' },
    ],
    columns: ['status', 'file', 'link'],
    func: async (page, kwargs) => {
        const prompt = kwargs.prompt;
        const ratio = normalizeRatio(String(kwargs.rt ?? '1:1'));
        const style = String(kwargs.st ?? '').trim();
        const outputDir = resolveOutputDir(kwargs.op);
        const timeout = kwargs.timeout;
        if (!Number.isInteger(timeout) || timeout < 1) {
            throw new ArgumentError('--timeout must be a positive integer (seconds)');
        }
        const startFresh = true;
        const skipDownloadRaw = kwargs.sd;
        const skipDownload = skipDownloadRaw === '' || skipDownloadRaw === true || normalizeBooleanFlag(skipDownloadRaw);
        const effectivePrompt = buildImagePrompt(prompt, {
            ratio,
            style: style || undefined,
        });
        if (startFresh)
            await startNewGeminiChat(page);
        const beforeUrls = await getGeminiVisibleImageUrls(page);
        await sendGeminiMessage(page, effectivePrompt);
        // Capture the conversation URL after send so a slow generation can be
        // re-queried on the same conversation without re-sending (re-sending
        // would duplicate the request and waste generation quota). Only report
        // failure once we can confirm no image exists — a transient poll miss
        // is not a failure.
        let convUrl = await currentGeminiLink(page);
        // 生成预算 --timeout + 20s 重试窗：慢生成在窗口内继续等图，不无限重试。
        // func 总时长 ≤ timeout+20 < CLI 层超时（timeout+30），保证报出
        // EmptyResultError 带对话 URL，而不是打印超时后进程挂起。
        const deadline = Date.now() + (timeout + 20) * 1000;
        let urls = await waitForGeminiImages(page, beforeUrls, timeout);
        let lastError = null;
        for (let attempt = 0; attempt < 3 && !urls.length && Date.now() < deadline; attempt += 1) {
            try {
                await page.wait(5);
                const u = await currentGeminiLink(page);
                if (u && u !== convUrl) convUrl = u;
                const remaining = Math.max(10, Math.ceil((deadline - Date.now()) / 1000));
                urls = await waitForGeminiImages(page, beforeUrls, remaining);
            }
            catch (err) {
                lastError = err;
            }
        }
        if (urls.length === 0 && lastError) {
            throw lastError;
        }
        const link = convUrl;
        if (!urls.length) {
            throw new EmptyResultError('gemini image', `No generated image was detected. Open ${link} and check whether Gemini produced one.`);
        }
        if (skipDownload) {
            return [{ status: '🎨 generated', file: '📁 -', link: `🔗 ${link}` }];
        }
        const assets = await exportGeminiImages(page, urls);
        if (!assets.length) {
            throw new CommandExecutionError('Failed to export the generated Gemini image', `Open ${link} and verify the image is visible, then retry.`);
        }
        const stamp = Date.now();
        const results = [];
        for (let index = 0; index < assets.length; index += 1) {
            const asset = assets[index];
            const base64 = asset.dataUrl.replace(/^data:[^;]+;base64,/, '');
            const suffix = assets.length > 1 ? `_${index + 1}` : '';
            const filePath = path.join(outputDir, `gemini_${stamp}${suffix}${extFromMime(asset.mimeType)}`);
            await saveBase64ToFile(base64, filePath);
            results.push({ status: '✅ saved', file: `📁 ${displayPath(filePath)}`, link: `🔗 ${link}` });
        }
        return results;
    },
});

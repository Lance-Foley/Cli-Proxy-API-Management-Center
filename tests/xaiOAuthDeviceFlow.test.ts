import { describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { apiClient } from '@/services/api/client';
import { oauthApi } from '@/services/api/oauth';
import en from '@/i18n/locales/en.json';
import zhCN from '@/i18n/locales/zh-CN.json';
import zhTW from '@/i18n/locales/zh-TW.json';
import ru from '@/i18n/locales/ru.json';

// Backend RequestXAIToken (auth_files_provider_oauth.go) runs a device-code flow: it returns
// flow "device" with user_code and polls xAI itself. It never reads is_webui or a callback file.
describe('xAI Management OAuth v8 device flow', () => {
  test('starts xAI without web UI callback mode', async () => {
    const response = {
      status: 'ok',
      url: 'https://accounts.x.ai/device',
      state: 'xai-1',
      flow: 'device',
      user_code: 'ABCD-EFGH',
      expires_in: 900,
    };
    const get = spyOn(apiClient, 'get').mockResolvedValue(response);
    try {
      expect(await oauthApi.startAuth('xai')).toEqual(response);
      expect(get).toHaveBeenCalledWith('/oauth/auth-url', { params: { provider: 'xai' } });
    } finally {
      get.mockRestore();
    }
  });

  test('does not offer a callback paste box for xAI', () => {
    const source = readFileSync(new URL('../src/pages/OAuthPage.tsx', import.meta.url), 'utf8');
    const match = source.match(/const CALLBACK_SUPPORTED = new Set<string>\(\[([^\]]*)\]\)/);
    expect(match).not.toBeNull();
    expect(match![1]).not.toContain("'xai'");
    expect(source).not.toContain('127.0.0.1:56121');
  });

  test('keeps xAI login copy and drops callback copy in all four languages', () => {
    for (const locale of [en, zhCN, zhTW, ru]) {
      const keys = Object.keys(locale.auth_login);
      expect(keys.some((key) => key.startsWith('xai_callback_'))).toBe(false);
      expect(locale.auth_login.xai_oauth_button?.trim()).toBeTruthy();
    }
  });
});

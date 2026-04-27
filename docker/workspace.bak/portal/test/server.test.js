import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app } from '../src/server';
import request from 'supertest';
let server;
beforeAll(async () => {
    server = app.listen(0);
});
afterAll(async () => {
    await new Promise(resolve => server.close(() => resolve()));
});
describe('portal server', () => {
    it('serves health', async () => {
        const res = await request(server).get('/health');
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
    });
    it('serves index.html', async () => {
        const res = await request(server).get('/');
        expect(res.status).toBe(200);
        expect(res.text).toContain('<!doctype html>');
    });
    it('returns tiles (at least seeds)', async () => {
        const res = await request(server).get('/api/tiles');
        expect(res.status).toBe(200);
        const body = res.body;
        expect(Array.isArray(body)).toBe(true);
        expect(body.find(t => t.url && t.url.includes('starkitconsulting.com'))).toBeTruthy();
    });
});

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], test: { include: ['src/**/*.test.ts'] }, resolve: { conditions: ['worker', 'module', 'browser', 'development|production'] }, clearScreen: false, server: { port: 1420, strictPort: true }, build: { target: 'safari15', sourcemap: true }, worker: { format: 'es' } });

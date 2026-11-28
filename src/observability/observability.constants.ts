/**
 * Службові шляхи не потрапляють у метрики, логи запитів і FAIL_RATE:
 *  - /metrics скрейпить Prometheus кожні 15 с (інакше «трафік» був би навіть без користувачів);
 *  - /health, /health/live — проби Kubernetes. Помилка, впорскнута в readiness, вивела б под з Service,
 *    і аналіз Argo Rollouts не побачив би помилок нової версії.
 */
export function isServicePath(path: string): boolean {
    return path === '/metrics' || path === '/health' || path.startsWith('/health/');
}

/** Шлях без query string: /hotels/1?x=2 -> /hotels/1. */
export function pathOf(url: string | undefined): string {
    const path = (url ?? '/').split('?')[0];
    return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

export type LogFormat = 'json' | 'text';

/** LOG_FORMAT=json|text; за замовчуванням json у production (Kubernetes), text — локально. */
export function logFormat(env: NodeJS.ProcessEnv = process.env): LogFormat {
    const value = env.LOG_FORMAT?.toLowerCase();
    if (value === 'json' || value === 'text') return value;
    return env.NODE_ENV === 'production' ? 'json' : 'text';
}

/** FAIL_RATE — частка запитів (0..1), на які под відповідає 500. Некоректне значення = 0. */
export function failRate(env: NodeJS.ProcessEnv = process.env): number {
    const value = Number.parseFloat(env.FAIL_RATE ?? '0');
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.min(value, 1);
}

import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

/**
 * Контекст HTTP-запиту, доступний у будь-якому місці коду без передачі параметрами
 * (AsyncLocalStorage). Потрібен маршрутизатору БД: щоб знати сесію (Sticky Routing)
 * і записати у відповідь, на який вузол пішли запити (X-DB-Node / X-DB-Route).
 */
export interface RequestContext {
    sessionId: string;
    res: Response;
    nodes: Set<string>;
    routes: Set<string>;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export const SESSION_HEADER = 'x-session-id';
const SESSION_COOKIE = 'sid';
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

function sessionFromCookie(cookie: string | undefined): string | undefined {
    const match = cookie?.match(/(?:^|;\s*)sid=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : undefined;
}

/**
 * Ідентифікатор сесії: заголовок X-Session-Id або cookie sid.
 * Якщо клієнт його не передав — видаємо новий (браузер і k6 повернуть його через cookie),
 * тому прив'язка «мої записи → Primary» працює без автентифікації.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
    use(req: Request, res: Response, next: NextFunction) {
        const fromHeader = req.headers[SESSION_HEADER];
        let sessionId = (Array.isArray(fromHeader) ? fromHeader[0] : fromHeader) ?? sessionFromCookie(req.headers.cookie);

        if (!sessionId || !SESSION_ID_RE.test(sessionId)) {
            sessionId = randomUUID();
            res.cookie(SESSION_COOKIE, sessionId, { httpOnly: true, sameSite: 'lax', path: '/' });
        }
        res.setHeader('X-Session-Id', sessionId);

        requestContext.run({ sessionId, res, nodes: new Set(), routes: new Set() }, () => next());
    }
}

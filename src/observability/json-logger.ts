import { LoggerService } from '@nestjs/common';

type Level = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'verbose';

const VERSION = process.env.APP_VERSION ?? 'dev';

/** Один JSON-об'єкт на рядок у stdout — формат, який Loki розбирає через `| json`. */
export function writeJsonLine(entry: Record<string, unknown>, out: (line: string) => void = (l) => process.stdout.write(l)) {
    out(`${JSON.stringify({ time: new Date().toISOString(), ...entry, version: VERSION })}\n`);
}

/**
 * Логер NestJS у форматі JSON (DevOps, Лаб. №7, п. 3): системні повідомлення Nest
 * (старт модулів, маршрути, помилки) теж ідуть у stdout по одному JSON-об'єкту на рядок.
 * Nest викликає log(message, context) і error(message, stack, context).
 */
export class JsonLogger implements LoggerService {
    constructor(private readonly out: (line: string) => void = (l) => process.stdout.write(l)) {}

    log(message: unknown, ...params: unknown[]) {
        this.write('info', message, params);
    }
    error(message: unknown, ...params: unknown[]) {
        this.write('error', message, params);
    }
    warn(message: unknown, ...params: unknown[]) {
        this.write('warn', message, params);
    }
    debug(message: unknown, ...params: unknown[]) {
        this.write('debug', message, params);
    }
    verbose(message: unknown, ...params: unknown[]) {
        this.write('verbose', message, params);
    }
    fatal(message: unknown, ...params: unknown[]) {
        this.write('fatal', message, params);
    }

    private write(level: Level, message: unknown, params: unknown[]) {
        const rest = [...params];
        // Останній рядковий параметр — контекст (ім'я класу), його додає Logger з new Logger('Context')
        const context = rest.length > 0 && typeof rest[rest.length - 1] === 'string' ? (rest.pop() as string) : undefined;
        const entry: Record<string, unknown> = { level, msg: this.text(message) };
        if (context) entry.context = context;
        if (message instanceof Error) entry.stack = message.stack;
        else if (level === 'error' && typeof rest[0] === 'string') entry.stack = rest[0];
        writeJsonLine(entry, this.out);
    }

    private text(message: unknown): string {
        if (typeof message === 'string') return message;
        if (message instanceof Error) return message.message;
        return JSON.stringify(message);
    }
}

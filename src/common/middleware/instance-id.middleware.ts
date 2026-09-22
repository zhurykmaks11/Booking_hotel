import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import * as os from 'os';

@Injectable()
export class InstanceIdMiddleware implements NestMiddleware {
    private readonly instanceId = os.hostname();

    use(req: Request, res: Response, next: NextFunction) {
        res.setHeader('X-Instance-ID', this.instanceId);
        next();
    }
}
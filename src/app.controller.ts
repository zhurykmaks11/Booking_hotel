import { Controller, Get } from '@nestjs/common';
import * as os from 'os';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  // Версія образу (build-arg APP_VERSION) та под, що обробив запит.
  // Використовується для демонстрації rolling update / rollback і розподілу трафіку між репліками.
  @Get('version')
  getVersion() {
    return {
      version: process.env.APP_VERSION ?? 'dev',
      instanceId: os.hostname(),
      environment: process.env.NODE_ENV ?? 'development',
    };
  }
}

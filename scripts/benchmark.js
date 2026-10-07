/**
 * Інструмент для тестування балансування навантаження, перевірки алгоритмів та Fault Tolerance
 * Лабораторна робота №3
 *
 * Використання:
 *   node scripts/benchmark.js distribution [-n 30] [-u http://localhost]
 *   node scripts/benchmark.js failover [-d 20] [-u http://localhost]
 *   node scripts/benchmark.js asymmetric [-n 30] [-c 6] [-u http://localhost]
 *   node scripts/benchmark.js switch <roundrobin|leastconn|iphash|weighted>
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const args = process.argv.slice(2);
const command = args[0] || 'distribution';

function getArg(flag, defaultValue) {
    const idx = args.indexOf(flag);
    if (idx !== -1 && args[idx + 1]) {
        return args[idx + 1];
    }
    return defaultValue;
}

const baseUrl = getArg('-u', 'http://localhost');
const targetPath = getArg('-p', '/health');

function sendRequest(url, headers = {}) {
    return new Promise((resolve) => {
        const start = Date.now();
        const req = http.get(url, { headers }, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
                const duration = Date.now() - start;
                resolve({
                    status: res.statusCode,
                    instanceId: res.headers['x-instance-id'] || 'unknown',
                    upstreamAddr: res.headers['x-upstream-addr'] || 'unknown',
                    duration,
                    data,
                });
            });
        });

        req.on('error', (err) => {
            const duration = Date.now() - start;
            resolve({
                status: 'ERROR',
                instanceId: 'none',
                upstreamAddr: 'none',
                duration,
                error: err.message,
            });
        });

        req.setTimeout(5000, () => {
            req.destroy(new Error('Timeout'));
        });
    });
}

async function runDistributionTest() {
    const totalRequests = parseInt(getArg('-n', '30'), 10);
    console.log(`\n=============================================================`);
    console.log(`   ТЕСТ РОЗПОДІЛУ ТРАФІКУ (Distribution Test)`);
    console.log(`   Цільовий URL: ${baseUrl}${targetPath}`);
    console.log(`   Кількість запитів: ${totalRequests}`);
    console.log(`=============================================================\n`);

    const stats = {};
    const latencies = [];

    for (let i = 1; i <= totalRequests; i++) {
        const res = await sendRequest(`${baseUrl}${targetPath}`);
        const id = res.instanceId;
        stats[id] = (stats[id] || 0) + 1;
        latencies.push(res.duration);

        const statusColor = res.status === 200 ? '\x1b[32m200 OK\x1b[0m' : `\x1b[31m${res.status}\x1b[0m`;
        console.log(
            `Запит #${String(i).padStart(2)} | ` +
            `Статус: ${statusColor} | ` +
            `Instance: \x1b[36m${id.padEnd(20)}\x1b[0m | ` +
            `Upstream: ${res.upstreamAddr.padEnd(16)} | ` +
            `Час: ${res.duration}ms`
        );

        // Коротка пауза між запитами
        await new Promise((r) => setTimeout(r, 100));
    }

    console.log(`\n------------------ РЕЗУЛЬТАТИ РОЗПОДІЛУ ------------------`);
    for (const [id, count] of Object.entries(stats)) {
        const pct = ((count / totalRequests) * 100).toFixed(1);
        const bar = '█'.repeat(Math.round(pct / 4));
        console.log(`  ${id.padEnd(22)} : ${String(count).padStart(3)} запитів (${pct.padStart(5)}%) ${bar}`);
    }

    const avgLatency = (latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(1);
    console.log(`----------------------------------------------------------`);
    console.log(`  Середня затримка (Avg Latency): ${avgLatency} ms\n`);
}

async function runFailoverTest() {
    const durationSeconds = parseInt(getArg('-d', '25'), 10);
    console.log(`\n=============================================================`);
    console.log(`   ТЕСТ СТІЙКОСТІ ДО ВІДМОВ (Fault Tolerance & Failover)`);
    console.log(`   Цільовий URL: ${baseUrl}${targetPath}`);
    console.log(`   Тривалість: ${durationSeconds} секунд`);
    console.log(`   👉 Підказка для захисту: під час виконання тесту виконайте:`);
    console.log(`      \x1b[33mdocker stop hotel_booking_api_1\x1b[0m`);
    console.log(`=============================================================\n`);

    const endTime = Date.now() + durationSeconds * 1000;
    let reqCount = 0;
    let successCount = 0;
    let failCount = 0;
    const stats = {};

    while (Date.now() < endTime) {
        reqCount++;
        const res = await sendRequest(`${baseUrl}${targetPath}`);
        if (res.status === 200) {
            successCount++;
            stats[res.instanceId] = (stats[res.instanceId] || 0) + 1;
            console.log(
                `[${new Date().toLocaleTimeString()}] Запит #${String(reqCount).padStart(3)}: ` +
                `\x1b[32m200 OK\x1b[0m від \x1b[36m${res.instanceId}\x1b[0m (${res.upstreamAddr}) [${res.duration}ms]`
            );
        } else {
            failCount++;
            console.log(
                `[${new Date().toLocaleTimeString()}] Запит #${String(reqCount).padStart(3)}: ` +
                `\x1b[31mПОМИЛКА (${res.status})\x1b[0m ${res.error || ''}`
            );
        }
        await new Promise((r) => setTimeout(r, 300));
    }

    console.log(`\n----------------- ПІДСУМОК FAILOVER ТЕСТУ -----------------`);
    console.log(`  Всього надіслано запитів : ${reqCount}`);
    console.log(`  Успішних (HTTP 200)      : \x1b[32m${successCount}\x1b[0m (${((successCount / reqCount) * 100).toFixed(1)}%)`);
    console.log(`  Помилок (5xx / drop)     : \x1b[31m${failCount}\x1b[0m`);
    console.log(`  Розподіл відповідей:`);
    for (const [id, count] of Object.entries(stats)) {
        console.log(`    - ${id}: ${count} запитів`);
    }
    console.log(`----------------------------------------------------------\n`);
}

async function runAsymmetricTest() {
    const totalRequests = parseInt(getArg('-n', '30'), 10);
    const concurrency = parseInt(getArg('-c', '6'), 10);

    console.log(`\n=============================================================`);
    console.log(`   ТЕСТ АСИМЕТРИЧНОГО НАВАНТАЖЕННЯ (Asymmetric Latency)`);
    console.log(`   Запитів: ${totalRequests}, Паралельних потоків: ${concurrency}`);
    console.log(`   (Імітація повільного вузла з передачею X-Synthetic-Delay: 400ms)`);
    console.log(`=============================================================\n`);

    const stats = {};
    const latencies = [];
    let completed = 0;

    async function worker() {
        while (completed < totalRequests) {
            completed++;
            const currentReq = completed;
            // Передаємо заголовок затримки для симуляції різного навантаження
            const res = await sendRequest(`${baseUrl}${targetPath}`, {
                'X-Synthetic-Delay': '200',
            });

            stats[res.instanceId] = (stats[res.instanceId] || 0) + 1;
            latencies.push(res.duration);

            console.log(
                `Запит #${String(currentReq).padStart(2)} завершено | ` +
                `Instance: \x1b[36m${res.instanceId.padEnd(20)}\x1b[0m | ` +
                `Час: ${res.duration}ms`
            );
        }
    }

    const workers = [];
    for (let i = 0; i < concurrency; i++) {
        workers.push(worker());
    }
    await Promise.all(workers);

    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const p95 = latencies[Math.floor(latencies.length * 0.95)];
    const p99 = latencies[Math.floor(latencies.length * 0.99)];

    console.log(`\n----------------- МЕТРИКИ АСИМЕТРИЧНОСТІ -----------------`);
    for (const [id, count] of Object.entries(stats)) {
        console.log(`  ${id.padEnd(22)} : ${count} запитів`);
    }
    console.log(`  p50 Latency: ${p50} ms`);
    console.log(`  p95 Latency: ${p95} ms`);
    console.log(`  p99 Latency: ${p99} ms`);
    console.log(`----------------------------------------------------------\n`);
}

function switchAlgorithm(algorithm) {
    const valid = ['roundrobin', 'leastconn', 'iphash', 'weighted'];
    if (!valid.includes(algorithm)) {
        console.error(`\x1b[31mНевідомий алгоритм: ${algorithm}\x1b[0m`);
        console.log(`Доступні варіанти: ${valid.join(', ')}`);
        process.exit(1);
    }

    const sourceFile = path.join(__dirname, '..', 'nginx', `nginx.${algorithm}.conf`);
    const targetFile = path.join(__dirname, '..', 'nginx.conf');

    if (!fs.existsSync(sourceFile)) {
        console.error(`\x1b[31mФайл ${sourceFile} не знайдено!\x1b[0m`);
        process.exit(1);
    }

    fs.copyFileSync(sourceFile, targetFile);
    console.log(`\x1b[32m✔ Конфігурацію оновлено на: ${algorithm} (скопійовано у nginx.conf)\x1b[0m`);

    try {
        console.log(`Перезавантаження Nginx конфігурації без переривання трафіку...`);
        execSync('docker exec hotel_booking_nginx nginx -s reload', { stdio: 'inherit' });
        console.log(`\x1b[32m✔ Nginx успішно оновив конфігурацію!\x1b[0m\n`);
    } catch (e) {
        console.log(`\x1b[33m(Якщо контейнери ще не запущені, зміни набудуть чинності після запуску docker compose up)\x1b[0m\n`);
    }
}

async function main() {
    switch (command.toLowerCase()) {
        case 'distribution':
        case 'dist':
            await runDistributionTest();
            break;
        case 'failover':
        case 'fault':
            await runFailoverTest();
            break;
        case 'asymmetric':
        case 'async':
            await runAsymmetricTest();
            break;
        case 'switch':
            switchAlgorithm(args[1]);
            break;
        default:
            console.log(`Використання:`);
            console.log(`  node scripts/benchmark.js distribution [-n 30]`);
            console.log(`  node scripts/benchmark.js failover [-d 20]`);
            console.log(`  node scripts/benchmark.js asymmetric [-n 30] [-c 6]`);
            console.log(`  node scripts/benchmark.js switch <roundrobin|leastconn|iphash|weighted>`);
    }
}

main().catch(console.error);

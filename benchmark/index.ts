/*!
 * Benchmark tests for imq module
 *
 * Copyright (c) 2018, Mykhailo Stadnyk <mikhus@gmail.com>
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
 * REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
 * AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
 * INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
 * LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
 * OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
 * PERFORMANCE OF THIS SOFTWARE.
 */
import * as mw from 'memwatch-next';
import { execSync as exec } from 'child_process';
import * as cluster from 'cluster';
import * as os from 'os';
import * as fs from 'fs';
import * as yargs from 'yargs';
import { run } from './redis-test';

/**
 * Command line args
 * @type {yargs.Arguments}
 */
const ARGV = yargs
    .help('h')
    .alias('h', 'help')

    .alias('c', 'children')
    .describe('c', 'Number of children test process to fork')

    .alias('d', 'delay')
    .describe('d', 'Number of milliseconds to delay message delivery for ' +
        'delayed messages. By default delayed messages is of and this ' +
        'argument is equal to 0.')

    .alias('m', 'messages')
    .describe('m', 'number of messages to be sent by a child process ' +
        'during test execution')

    .boolean(['h'])
    .argv;

const na = require('nodeaffinity');

mw.on('leak', (info) => console.error('Memory leak detected:\n', info));

let maxChildren = Number(ARGV.c) || 1;

const METRICS_DELAY = 100;
const CPUS = os.cpus();
const numCpus = CPUS.length;
const CPU_NAMES = ['redis'];

if (numCpus - 2 < maxChildren) {
    maxChildren = numCpus - 2;
}

if (!maxChildren) {
    maxChildren = 1;
}

for (let i = 0; i < maxChildren; i++) {
    CPU_NAMES.push(`imq${i + 1}`);
}

/**
 * Returns usage metrics for a given CPU
 *
 * @param {number} i
 * @returns {{idle: number; total: number}}
 */
function cpuAvg(i: number) {
    const cpus = os.cpus();
    const cpu: any = cpus[i];
    let totalIdle = 0;
    let totalTick = 0;

    for (let type in cpu.times) {
        totalTick += cpu.times[type];
    }

    totalIdle += cpu.times.idle;

    return {
        idle: totalIdle / cpus.length,
        total: totalTick / cpus.length
    };
}

/**
 * Prepares and saves stats from a given collected metrics
 *
 * @param {any[]} metrics
 */
function saveStats(metrics: any[]) {
    const stats: any[] = [];

    for (let i = 1, s = metrics.length; i < s; i++) {
        for (let cpu = 0, ss = CPU_NAMES.length; cpu < ss; cpu++) {
            const idle = metrics[i][cpu].idle - metrics[i - 1][cpu].idle;
            const total = metrics[i][cpu].total - metrics[i - 1][cpu].total;

            if (!stats[cpu]) {
                stats[cpu] = [CPU_NAMES[cpu]];
            }

            stats[cpu].push(100 - ~~(100 * idle / total));
        }
    }

    const config = {
        data: {
            columns: stats
        },
        axis: {
            x: {
                type: 'category',
                categories: stats[0].slice(1).map((v: any, i: number) =>
                    (i * 100) + 'ms')
            }
        },
        zoom: {
            enabled: true
        }
    };

    fs.writeFileSync('./stats.json', JSON.stringify(config));
    console.log('CPU stats saved to stats.json file.');
}

// main program:

if (cluster.isMaster) {
    na.setAffinity(1);

    const statsWorker = cluster.fork();
    statsWorker.send('stats');

    const done: boolean[] = [];

    for (let i = 0; i < maxChildren; i++) {
        done[i] = false;
        const worker = cluster.fork();
        worker.send(`imq ${i}`);

        worker.on('message', (msg: string) => {
            const index = parseInt(String(msg.split(/\s+/).pop()), 10);
            done[index] = true;

            if (!~done.indexOf(false)) {
                statsWorker.send('stop');
                process.exit(0);
            }
        });
    }
}

else {
    const metrics: any[] = [];
    let metricsInterval: any;

    process.on('message', async (msg: string) => {
        if (/^imq/.test(msg)) {
            const index = parseInt(String(msg.split(/\s+/).pop()), 10);
            const mask = numCpus <= 2 ? 1 : Math.pow(2, index + 2);

            na.setAffinity(mask);

            try {
                await run(
                    Number(ARGV.m) || 10000,
                    Number(ARGV.d) || 0
                );
            }

            catch (err) {
                console.error(err.stack);
                process.exit(1);
            }

            (<any>process).send(`img ${index}`);
            process.exit(0);
        }

        else if (msg === 'stats') {
            na.setAffinity(1);

            const redisProcess = exec('ps ax|grep redis-server')
                .toString('utf8')
                .split(/\r?\n/)[0];
            const mask = numCpus < 2 ? 1 : 2;

            if (/redis-server/.test(redisProcess) && !/grep/.test(redisProcess)) {
                const redisPid = parseInt(redisProcess.split(/\s+/)[0], 10);
                redisPid && exec(`taskset -p ${mask} ${redisPid}`);
            }

            metricsInterval = setInterval(() => {
                metrics.push(
                    CPU_NAMES.map((name: string, i: number) => cpuAvg(i + 1))
                );
            }, METRICS_DELAY)
        }

        else if (msg === 'stop') {
            metricsInterval && clearInterval(metricsInterval);
            saveStats(metrics);
            process.exit(0);
        }
    });
}

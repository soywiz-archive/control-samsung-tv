#!/usr/bin/env node

/////////////////////////////////////////////////////////////////////////////////////////////////////////
// Allows to discover and control Samsung TVs directly from CLI
//
// Discovery code, cache and main program - Copyright (c) 2025 soywiz
//
// Save this file as `control-samsung-tv.ts` and `chmod +x` it
/////////////////////////////////////////////////////////////////////////////////////////////////////////

import { SamsungTvRemote, Keys } from "samsung-tv-remote"
import fs from 'fs'
import dgram from 'dgram';
import net from 'net';
import os from 'os';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { exec } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import { Buffer } from 'buffer';
import WebSocket from 'ws';

interface DeviceInfo {
    friendlyName: string
    ip: string
    mac: string
}

function getSamsungDevices(timeMs: number = 250): Promise<DeviceInfo[]> {
    return new Promise((resolve, reject) => {
        const devices: DeviceInfo[] = []
        const socket = dgram.createSocket('udp4');

        const ssdpMSearch = [
            'M-SEARCH * HTTP/1.1',
            'HOST: 239.255.255.250:1900',
            'MAN: "ssdp:discover"',
            'MX: 10',
            'ST: urn:dial-multiscreen-org:service:dial:1',
            '',
            ''
        ].join('\r\n');

        socket.on('listening', () => {
            socket.setBroadcast(true);
            socket.setMulticastTTL(2); // TTL = 2 to limit to local network

            const message = Buffer.from(ssdpMSearch);
            const multicastAddress = '239.255.255.250';
            const port = 1900;

            // Send M-SEARCH message
            socket.send(message, 0, message.length, port, multicastAddress, (err) => {
                if (err) console.error('Error sending:', err);
                //else console.log('M-SEARCH ent');
            });
        });

        socket.on('message', async (msg, rinfo) => {
            const response = msg.toString();

            if (response.includes('Samsung')) {
                let obj = {} as any
                for (const line of response.split("\n")) {
                    const spos = line.indexOf(':')
                    if (spos < 0) continue;
                    const key = line.substring(0, spos).trim().toUpperCase()
                    const value = line.substring(spos + 1).trim()
                    obj[key] = value
                }

                let friendlyName = rinfo.address
                let ipAddress = rinfo.address
                let macAddress = "00:00:00:00:00:00"

                if (obj.LOCATION) {
                    try {
                        const result = await (await fetch(obj.LOCATION)).text()
                        const regexp = /<friendlyName>(.*?)<\/friendlyName>/ig
                        friendlyName = [...result.matchAll(regexp)]?.[0]?.[1]
                    } catch (e) {
                        console.error(e)
                    }
                }

                const macMatch = response.match(/WAKEUP:\s*MAC=([0-9a-fA-F:]+)/);
                if (macMatch) {
                    macAddress = macMatch[1];
                }

                devices.push({ friendlyName: friendlyName, ip: ipAddress, mac: macAddress })
                //console.log(`Device: friendlyName: ${friendlyName}, ip: ${ipAddress}, mac: ${macAddress}`);
            }
        });

        socket.bind();

        let startTime = Date.now()
        let interval = setInterval(() => {
            const elapsedTime = Date.now() - startTime
            //console.log('interval')
            if (devices.length > 0 || elapsedTime >= timeMs) {
                resolve(devices)
                socket.close();
                clearInterval(interval)
            }
        }, 25)
    })
}

async function getCachedSamsungDevices(): Promise<DeviceInfo[]> {
    function getCachePath(name = 'badisi-samsung-tv-remote-device-cache.json') {
        switch (process.platform) {
            case 'darwin': return `${os.homedir()}/Library/Caches/${name}`
            case 'win32': return `${(process.env.LOCALAPPDATA || `${os.homedir()}/AppData/Local`)}/${name}`
            default: return `${(process.env.XDG_CACHE_HOME || `${os.homedir()}/.cache`)}/${name}`
        }
    }

    const cachePath = getCachePath()
    let result = {}
    try {
        result = JSON.parse(await fs.promises.readFile(cachePath, { encoding: 'utf-8' }))
    } catch (e) {
    }
    if (typeof result !== 'object') result = {};

    //console.log(typeof result)

    for (const device of await getSamsungDevices()) {
        result[device.mac] = device
    }

    await fs.promises.writeFile(cachePath, JSON.stringify(result))

    return Object.values(result)
}

function deviceToString(device: DeviceInfo | undefined) {
    if (!device) return 'Unknown'
    return `${device.friendlyName}, ip: ${device.ip}, mac: ${device.mac}`
}

const main = async () => {
    const fileHandle = await fs.promises.open('/dev/stdin', 'r');
    process.stdin.setRawMode(true);

    const devices = await getCachedSamsungDevices()
    if (devices.length == 0) {
        console.log("Couldn't find any Samsung device")
        process.exit(-1)
    }

    let selectedDevice = devices[0]

    if (devices.length > 1) {
        console.log("Select device:")
        for (let n = 0; n < devices.length; n++) {
            const device = devices[n]
            console.log(` ${n}: ${deviceToString(device)}`)
        }
        console.log("Waiting for key, q to quit...")

        while (true) {
            const buffer = Buffer.alloc(3);
            const { bytesRead } = await fileHandle.read(buffer, 0, 3, null);
            const key = buffer.slice(0, bytesRead).toString().replace(/\u0000/g, '');
            if (key == 'q') process.exit(-1);
            const number = parseInt(key)
            selectedDevice = devices[number]
            if (selectedDevice) break
        }
    }

    console.log(`Selected ${deviceToString(selectedDevice)}`)

    const remote = new SamsungTvRemote({
        ip: selectedDevice.ip,
        mac: selectedDevice.mac
    });
    await remote.wakeTV();

    console.log('Press any key: q-Shutdown and Quit, f-Force Quit, w-Wake TV, +- -> Volume, Arrows, ENTER, ESC, BACKSPACE');

    while (true) {
        const buffer = Buffer.alloc(3);
        const { bytesRead } = await fileHandle.read(buffer, 0, 3, null);

        const key = buffer.slice(0, bytesRead).toString().replace(/\u0000/g, '');

        console.log(`Pressed: '${key}', ${[...key].map(c => c.charCodeAt(0).toString(16).padStart(2, '0'))}`);

        switch (key) {
            case '0': await remote.sendKey(Keys.KEY_0 as any); break;
            case '1': await remote.sendKey(Keys.KEY_1 as any); break;
            case '2': await remote.sendKey(Keys.KEY_2 as any); break;
            case '3': await remote.sendKey(Keys.KEY_3 as any); break;
            case '4': await remote.sendKey(Keys.KEY_4 as any); break;
            case '5': await remote.sendKey(Keys.KEY_5 as any); break;
            case '6': await remote.sendKey(Keys.KEY_6 as any); break;
            case '7': await remote.sendKey(Keys.KEY_7 as any); break;
            case '8': await remote.sendKey(Keys.KEY_8 as any); break;
            case '9': await remote.sendKey(Keys.KEY_9 as any); break;
            case '\u001b[A': await remote.sendKey(Keys.KEY_UP as any); break;
            case '\u001b[B': await remote.sendKey(Keys.KEY_DOWN as any); break;
            case '\u001b[C': await remote.sendKey(Keys.KEY_RIGHT as any); break;
            case '\u001b[D': await remote.sendKey(Keys.KEY_LEFT as any); break;
            case '\u007f': await remote.sendKey(Keys.KEY_BACK_MHP as any); break;
            case '\u001b': await remote.sendKey(Keys.KEY_HOME as any); break;
            //case '\x09': await remote.sendKey(Keys.KEY_TOOLS as any); break;
            case '\r': await remote.sendKey(Keys.KEY_ENTER as any); break;
            case 'p': await remote.sendKey(Keys.KEY_PLAY as any); break;
            case '+': await remote.sendKey(Keys.KEY_VOLUP as any); break;
            case '-': await remote.sendKey(Keys.KEY_VOLDOWN as any); break;
            case 'w': await remote.sendKey(Keys.KEY_CHUP as any); break;
            case 's': await remote.sendKey(Keys.KEY_CHDOWN as any); break;
            case 'q':
                await remote.sendKeys([Keys.KEY_POWER as any]);
                console.log('Exiting...');
                process.exit();
                break;
            case '\u0003':
            case 'f':
                console.log('Force Exiting...');
                process.exit();
                break;
            default:
                [...key].map(it => String.fromCharCode())
                break;
        }
    }
};

main().catch(console.error);
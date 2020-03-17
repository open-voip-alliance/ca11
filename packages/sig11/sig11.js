import http from 'http'

import EventEmitter from 'eventemitter3'
global.EventEmitter = EventEmitter

import btoa from 'btoa'
global.btoa = btoa
import WebCrypto from 'node-webcrypto-ossl'

global.crypto = new WebCrypto()
import rc from 'rc'
import knex from 'knex'
import WebSocket from 'ws'

import {Skeleton} from '@ca11/webphone/lib/skeleton.js'
import Crypto from './lib/crypto.js'
import Endpoint from './lib/endpoint.js'
import Network from './lib/network.js'

let settings = {}

rc('ca11', settings)

class Ca11Tower extends Skeleton {

    constructor() {
        super()

        this.crypto = new Crypto(this)
        this.network = new Network(this)

        this.knex = knex(settings.tower.knex)
        this.setup()
    }


    async onConnection(ws, req) {
        const endpoint = new Endpoint(this.network, {}, ws)

        // Transport data handler.
        ws.on('message', async(msg) => {
            try {
                msg = JSON.parse(msg)
            } catch (err) {
                return
            }
            if (msg.length === 3) {
                await this.network.protocol.in(msg, endpoint)
            } else if (msg.length === 4) {
                this.network.protocol.inRelay(msg, endpoint)
            }
        })

        endpoint.once('sig11:identified', this.onIdentify.bind(this, endpoint))

        ws.on('close', () => {
            this.network.removeEndpoint(endpoint)
            const msg = this.network.protocol.out('node-removed', endpoint.serialize())
            this.network.broadcast(msg)
        })
    }


    async onIdentify(endpoint) {
        // SIP entity is a hash of the public key.
        const rows = await this.knex.from('sig11_asterisk').select('*').where({
            pubkey: endpoint.id,
        })

        if (!rows.length) {
            const sipId = endpoint.number
            await Promise.all([
                this.knex('sig11_asterisk').insert({
                    id: sipId,
                    pubkey: endpoint.id,
                }),
                this.knex('ps_aors').insert({
                    id: sipId,
                    max_contacts: 1,
                }),
                this.knex('ps_auths').insert({
                    auth_type: 'userpass',
                    id: sipId,
                    password: sipId,
                    username: sipId,
                }),
                this.knex('ps_endpoints').insert({
                    allow: 'g722',
                    aors: sipId,
                    auth: sipId,
                    context: 'default',
                    direct_media: 'no',
                    disallow: 'all',
                    id: sipId,
                    transport: 'transport-wss',
                    webrtc: 'yes',
                }),
            ])

            endpoint.send(this.network.protocol.out('services', {
                sip: {
                    account: {
                        password: sipId,
                        username: sipId,
                    },
                },
            }))
        }

        this.network.addEndpoint(endpoint, this.network.identity)
        endpoint.send(this.network.protocol.out('network', this.network.export()))

        const msg = this.network.protocol.out('node-added', {
            node: endpoint.serialize(),
            parent: this.network.identity,
        })
        // Notify others about the new node.
        this.network.broadcast(msg, {excludes: [endpoint]})
    }


    async setup() {
        this.keypair = await this.crypto.createIdentity()
        this.network.setIdentity(this.keypair)

        this.server = http.createServer()
        this.wss = new WebSocket.Server({
            disableHixie: true,
            perMessageDeflate: false,
            protocolVersion: 17,
            server: this.server,
        })

        this.wss.on('connection', this.onConnection.bind(this))
        this.server.listen(settings.tower.port, () => [
            this.logger.info(`listening on port ${settings.tower.port}`),
        ])
    }
}

global.ca11tower = new Ca11Tower()
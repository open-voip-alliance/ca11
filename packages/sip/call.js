import EventEmitter from 'eventemitter3'
import { magicCookie, SipRequest, SipResponse, utils } from './message.js'

class CallSip extends EventEmitter {

    constructor(client, {description, id}) {
        super()
        this.client = client
        this.tracks = {}

        // Keep track of multiple dialogs.
        this.dialogs = {
            invite: {branch: utils.token(12), toTag: null},
            options: {toTag: null},
        }
        this.localTag = utils.token(12)

        this.id = id
        this.description = description
        this.on('message', this.onMessage.bind(this))
    }


    async acceptCall(localStream) {
        this.pc = new RTCPeerConnection({
            iceServers: this.client.stun.map((i) => ({urls: i})),
            sdpSemantics:'unified-plan',
        })

        this.pc.ontrack = this.onTrack.bind(this)
        await this.pc.setRemoteDescription({sdp: this.inviteContext.context.content, type: 'offer'})

        for (const track of localStream.getTracks()) {
            this.pc.addTrack(track, localStream)
        }

        const answer = await this.pc.createAnswer()
        await this.pc.setLocalDescription(answer)

        // Incoming call/invite accepted.
        const inviteResponse = new SipResponse(this.client, {
            callId: this.id,
            code: 200,
            content: answer.sdp,
            cseq: this.inviteContext.context.cseq,
            extension: this.description.endpoint,
            from: {tag: this.dialogs.invite.toTag},
            method: 'INVITE',
            to: {tag: this.localTag},
            via: {branch: this.dialogs.invite.branch},
        })

        this.client.socket.send(inviteResponse)
        this.emit('invite-accepted')
    }


    hold() {
        console.log("HOLD CALL")
    }


    async initIncoming({context}) {
        const message = context

        this.inviteContext = message
        this.dialogs.invite.branch = message.context.headers.via.branch
        this.inviteCseq = message.context.cseq

        const tryingResponse = new SipResponse(this.client, {
            callId: this.id,
            code: 100,
            cseq: message.context.cseq,
            extension: this.description.endpoint,
            from: {tag: this.localTag},
            method: 'INVITE',
            via: {branch: this.dialogs.invite.branch},
        })

        const ringingResponse = new SipResponse(this.client, {
            branch: this.dialogs.invite.branch,
            callId: this.id,
            code: 180,
            cseq: message.context.cseq,
            extension: this.description.endpoint,
            from: {tag: this.localTag},
            method: 'INVITE',
            to: {tag: this.dialogs.invite.toTag},
            via: {branch: this.dialogs.invite.branch},
        })

        this.client.socket.send(tryingResponse)
        this.client.socket.send(ringingResponse)
    }


    async initOutgoing(localStream) {
        this.pc = new RTCPeerConnection({
            iceServers: this.client.stun.map((i) => ({urls: i})),
            sdpSemantics:'unified-plan',
        })

        this.pc.ontrack = this.onTrack.bind(this)
        this.pc.onicegatheringstatechange = () => {
            // Send the invite once the candidates are part of the sdp.
            if (this.pc.iceGatheringState === 'complete') {
                this.client.calls[this.id] = this
                if (this.status !== 'accepted') {
                    const inviteRequest = new SipRequest(this.client, {
                        callId: this.id,
                        content: this.pc.localDescription.sdp,
                        cseq: this.client.cseq,
                        extension: this.description.endpoint,
                        from: {tag: this.localTag},
                        method: 'INVITE',
                        via: {branch: `${magicCookie}${utils.token(7)}`},
                    })

                    this.client.socket.send(inviteRequest)
                }

            }
        }

        for (const track of localStream.getTracks()) {
            this.pc.addTrack(track, localStream)
        }

        const offer = await this.pc.createOffer()
        this.pc.setLocalDescription(offer)
    }


    keyPress(key) {
        this.client.cseq += 1
        const dtmfRequest = new SipRequest(this.client, {
            callId: this.id,
            content: `Signal= ${key}\r\nDuration= 100\r\n`,
            cseq: this.client.cseq,
            extension: this.description.endpoint,
            from: {tag: this.localTag},
            method: 'INFO',
            to: {tag: this.dialogs.invite.toTag},
            via: {branch: this.dialogs.invite.branch},
        })

        this.client.socket.send(dtmfRequest)
    }


    async onMessage(message) {
        if (message.context.method === 'INVITE') {
            if (this.status === 'accepted') {
                this.dialogs.invite.branch = message.context.header.Via.branch

                if (message instanceof SipRequest) {
                    // Match stream to ConfBridge.
                    // TODO Match label and stream id with Confbridge stats.
                    for (const media of message.sdp.media) {
                        if (media.label) {
                            console.log("GOT LABEL!", media, media.label)
                        }
                    }

                    await this.pc.setRemoteDescription({sdp: message.context.content, type: 'offer'})
                    const answer = await this.pc.createAnswer()
                    await this.pc.setLocalDescription(answer)

                    // Incoming call/invite accepted.
                    const inviteResponse = new SipResponse(this.client, {
                        callId: this.id,
                        code: 200,
                        content: answer.sdp,
                        cseq: message.context.cseq,
                        digest: this.digest,
                        extension: this.description.endpoint,
                        from: {tag: this.dialogs.invite.toTag},
                        method: 'INVITE',
                        to: {tag: this.localTag},
                        via: {branch: this.dialogs.invite.branch},
                    })

                    this.client.socket.send(inviteResponse)
                }

            }
            if (message.context.status === 'Unauthorized') {
                this.dialogs.invite.toTag = message.context.header.To.tag

                if (message.context.digest) {
                    this.digest = message.context.digest

                    // Initiate an outgoing call with credentials.
                    this.dialogs.invite.branch = `${magicCookie}${utils.token(7)}`
                    const inviteRequest = new SipRequest(this.client, {
                        callId: this.id,
                        content: this.pc.localDescription.sdp,
                        cseq: message.context.cseq,
                        digest: message.context.digest,
                        extension: this.description.endpoint,
                        from: {tag: this.localTag},
                        method: 'INVITE',
                        via: {branch: this.dialogs.invite.branch},
                    })

                    const ackRequest = new SipRequest(this.client, {
                        branch: this.dialogs.invite.branch,
                        callId: this.id,
                        cseq: message.context.cseq,
                        extension: this.description.endpoint,
                        from: {tag: this.localTag},
                        method: 'ACK',
                        to: {tag: this.dialogs.invite.toTag},
                    })

                    this.client.socket.send(ackRequest)
                    this.client.socket.send(inviteRequest)
                }
            } else if (message.context.status === 'OK') {
                this.dialogs.invite.toTag = message.context.header.To.tag
                await this.pc.setRemoteDescription({sdp: message.context.content, type: 'answer'})

                // MISSING AORS
                const ackRequest = new SipRequest(this.client, {
                    branch: this.dialogs.invite.toTag,
                    callId: this.id,
                    cseq: message.context.cseq,
                    extension: this.description.endpoint,
                    from: {tag: this.localTag},
                    method: 'ACK',
                    to: {tag: this.dialogs.invite.toTag},
                    transport: 'ws',
                })
                this.client.socket.send(ackRequest)
                // Outgoing call accepted;
                this.status = 'accepted'
                this.emit('outgoing-accepted')

            }
        } else if (message.context.method === 'BYE') {
            this.emit('terminate', {callID: this.id})
        } else if (message.context.method === 'MESSAGE') {
            const infoMsg = JSON.parse(message.context.content)

            const messageResponse = new SipResponse(this.client, {
                callId: this.id,
                code: 501,
                cseq: message.context.cseq,
                extension: this.description.endpoint,
                from: {aor: message.context.header.From.raw, tag: this.dialogs.invite.toTag},
                method: 'MESSAGE',
                to: {aor: message.context.header.To.aor, tag: this.localTag},
                via: {branch: this.dialogs.invite.branch, rport: true},
            })

            this.client.socket.send(messageResponse)

            if (['ConfbridgeLeave', 'ConfbridgeJoin', 'ConfbridgeWelcome'].includes(infoMsg.type)) {

                if (infoMsg.type === 'ConfbridgeLeave') {
                    this.emit('conference', {
                        action: 'leave',
                        user: {
                            displayName: 'Bob',
                            streamId: null,
                        },
                    })
                } else if (infoMsg.type === 'ConfbridgeJoin') {
                    this.emit('conference', {
                        action: 'join',
                        user: {
                            displayName: 'Bob',
                            streamId: null,
                        },
                    })
                } else {
                    this.emit('conference', {
                        action: 'enter',
                        user: {
                            displayName: 'Bob',
                            streamId: null,
                        },
                    })
                }

            }

        }
    }


    onTrack(rtcTrackEvent) {
        const track = rtcTrackEvent.receiver.track
        this.tracks[track.id] = track
        const newStream = new MediaStream()
        newStream.addTrack(track)

        track.onended = () => {
            this.emit('trackended', newStream, track)
            delete this.tracks[track.id]
        }
        this.emit('track', newStream, track)
    }


    terminate() {
        this.client.cseq += 1
        const byeMessage = new SipRequest(this.client, {
            branch: this.dialogs.invite.branch,
            callId: this.id,
            cseq: this.client.cseq,
            extension: this.description.endpoint,
            fromTag: this.localTag,
            method: 'BYE',
            toTag: this.dialogs.invite.toTag,
            transport: 'ws',
        })

        this.client.socket.send(byeMessage)
    }


    transfer(targetCall) {
        if (typeof targetCall === 'string') {
            this.session.refer(`sip:${targetCall}@ca11.app`)
        } else {
            this.session.refer(targetCall.session)
        }
    }


    unhold() {
        if (this.session) {
            this.session.unhold({
                sessionDescriptionHandlerOptions: {
                    constraints: this.app.media._getUserMediaFlags(),
                },
            })
            this.setState({hold: {active: false}})
        }
    }
}

export default CallSip

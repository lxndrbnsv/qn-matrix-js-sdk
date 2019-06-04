/*
Copyright 2019 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import {EventEmitter} from 'events';
import logger from '../logger';
import olmlib from './olmlib';

/** Implements MSC-1946
 */
export default class SecretStorage extends EventEmitter {
    constructor(baseApis) {
        super();
        this._baseApis = baseApis;
        this._requests = {};
        this._incomingRequests = {};
    }

    /** store an encrypted secret on the server
     *
     * @param {string} name The name of the secret
     * @param {string} secret The secret contents.
     * @param {Array} keys The IDs of the keys to use to encrypt the secret
     */
    async store(name, secret, keys) {
        const encrypted = {};

        for (const keyName of keys) {
            // get key information from key storage
            const keyInfo = this._baseApis.getAccountData(
                "m.secret_storage.key." + keyName,
            );
            if (!keyInfo) {
                continue;
            }
            const keyInfoContent = keyInfo.getContent();
            // FIXME: check signature of key info
            // encrypt secret, based on the algorithm
            switch (keyInfoContent.algorithm) {
            case "m.secret_storage.v1.curve25519-aes-sha2":
            {
                const encryption = new global.Olm.PkEncryption();
                try {
                    encryption.set_recipient_key(keyInfoContent.pubkey);
                    encrypted[keyName] = encryption.encrypt(secret);
                } finally {
                    encryption.free();
                }
                break;
            }
            default:
                logger.warn("unknown algorithm for secret storage key " + keyName
                            + ": " + keyInfoContent.algorithm);
                // do nothing if we don't understand the encryption algorithm
            }
        }

        // save encrypted secret
        await this._baseApis.setAccountData(name, {encrypted});
    }

    async get(name) {
        const secretInfo = this._baseApis.getAccountData(name);
        if (!secretInfo) {
            return;
        }

        const secretContent = secretInfo.getContent();

        if (!secretContent.encrypted) {
            return;
        }

        // get possible keys to decrypt
        const keys = {};
        for (const keyName of Object.keys(secretContent.encrypted)) {
            // get key information from key storage
            const keyInfo = this._baseApis.getAccountData(
                "m.secret_storage.key." + keyName,
            ).getContent();
            const encInfo = secretContent.encrypted[keyName];
            switch (keyInfo.algorithm) {
            case "m.secret_storage.v1.curve25519-aes-sha2":
                if (keyInfo.pubkey && encInfo.ciphertext && encInfo.mac
                    && encInfo.ephemeral) {
                    keys[keyName] = keyInfo;
                }
                break;
            default:
                // do nothing if we don't understand the encryption algorithm
            }
        }

        // fetch private key from app
        let decryption;
        let keyName;
        let cleanUp;
        let error;
        do {
            [keyName, decryption, cleanUp] = await new Promise((resolve, reject) => {
                this._baseApis.emit("crypto.secrets.getKey", {
                    keys,
                    error,
                    done: function(keyName, key) {
                        // FIXME: interpret key?
                        if (!keys[keyName]) {
                            error = "Unknown key (your app is broken)";
                            resolve([]);
                        }
                        switch (keys[keyName].algorithm) {
                        case "m.secret_storage.v1.curve25519-aes-sha2":
                        {
                            const decryption = new global.Olm.PkDecryption();
                            try {
                                const pubkey = decryption.init_with_private_key(key);
                                if (pubkey !== keys[keyName].pubkey) {
                                    error = "Key does not match";
                                    resolve([]);
                                    return;
                                }
                            } catch (e) {
                                decryption.free();
                                error = "Invalid key";
                                resolve([]);
                                return;
                            }
                            resolve([
                                keyName,
                                decryption,
                                decryption.free.bind(decryption),
                            ]);
                            break;
                        }
                        default:
                            error = "The universe is broken";
                            resolve([]);
                        }
                    },
                    cancel: function(e) {
                        reject(e || new Error("Cancelled"));
                    },
                });
            });
            if (error) {
                logger.error("Error getting private key:", error);
            }
        } while (!keyName);

        // decrypt secret
        try {
            const encInfo = secretContent.encrypted[keyName];
            switch (keys[keyName].algorithm) {
            case "m.secret_storage.v1.curve25519-aes-sha2":
                return decryption.decrypt(
                    encInfo.ephemeral, encInfo.mac, encInfo.ciphertext,
                );
            }
        } finally {
            cleanUp();
        }
    }

    isStored(name, checkKey) {
        // check if secret exists
        const secretInfo = this._baseApis.getAccountData(name);
        if (!secretInfo) {
            return false;
        }

        const secretContent = secretInfo.getContent();

        if (!secretContent.encrypted) {
            return false;
        }

        // check if secret is encrypted by a known/trusted secret and
        // encryption looks sane
        for (const keyName of Object.keys(secretContent.encrypted)) {
            // get key information from key storage
            const keyInfo = this._baseApis.getAccountData(
                "m.secret_storage.key." + keyName,
            ).getContent();
            const encInfo = secretContent.encrypted[keyName];
            if (checkKey) {
                // FIXME: check signature on key
            }
            switch (keyInfo.algorithm) {
            case "m.secret_storage.v1.curve25519-aes-sha2":
                if (keyInfo.pubkey && encInfo.ciphertext && encInfo.mac
                    && encInfo.ephemeral) {
                    return true;
                }
                break;
            default:
                // do nothing if we don't understand the encryption algorithm
            }
        }
        return false;
    }

    request(name, devices) {
        const requestId = this._baseApis.makeTxnId();

        const requestControl = this._requests[requestId] = {
            devices,
        };
        const promise = new Promise((resolve, reject) => {
            requestControl.resolve = resolve;
            requestControl.reject = reject;
        });
        const cancel = (reason) => {
            // send cancellation event
            const cancelData = {
                action: "cancel_request",
                requesting_device_id: this._baseApis.deviceId,
                request_id: requestId,
            };
            const toDevice = {};
            for (const device of devices) {
                toDevice[device] = cancelData;
            }
            this._baseApis.sendToDevice("m.secret.request", {
                [this._baseApis.getUserId()]: toDevice,
            });

            // and reject the promise so that anyone waiting on it will be
            // notified
            requestControl.reject(new Error(reason ||"Cancelled"));
        };

        // send request to devices
        const requestData = {
            name,
            action: "request",
            requesting_device_id: this._baseApis.deviceId,
            request_id: requestId,
        };
        const toDevice = {};
        for (const device of devices) {
            toDevice[device] = requestData;
        }
        this._baseApis.sendToDevice("m.secret.request", {
            [this._baseApis.getUserId()]: toDevice,
        });

        return {
            request_id: requestId,
            promise,
            cancel,
        };
    }

    _onRequestReceived(event) {
        const sender = event.getSender();
        const content = event.getContent();
        if (sender !== this._baseApis.getUserId()
            || !(content.name && content.action
                 && content.requesting_device_id && content.request_id)) {
            // ignore requests from anyone else, for now
            return;
        }
        const deviceId = content.requesting_device_id;
        // check if it's a cancel
        if (content.action === "cancel_request") {
            if (this._incomingRequests[deviceId]
                && this._incomingRequests[deviceId][content.request_id]) {
                logger.info("received request cancellation for secret (" + sender
                            + ", " + deviceId + ", " + content.request_id + ")");
                this.baseApis.emit("crypto.secrets.request_cancelled", {
                    user_id: sender,
                    device_id: deviceId,
                    request_id: content.request_id,
                });
            }
        } else if (content.action === "request") {
            // if from us and device is trusted (or else check trust)
            // check if we have the secret
            logger.info("received request for secret (" + sender
                        + ", " + deviceId + ", " + content.request_id + ")");
            this._baseApis.emit("crypto.secrets.request", {
                sender: sender,
                device_id: deviceId,
                request_id: content.request_id,
                name: content.name,
                device_trust: this._baseApis.checkDeviceTrust(sender, deviceId),
                send: async (secret) => {
                    const payload = {
                        type: "m.secret.share",
                        content: {
                            request_id: content.request_id,
                            secret: secret,
                        },
                    };
                    const encryptedContent = {
                        algorithm: olmlib.OLM_ALGORITHM,
                        sender_key: this._baseApis._crypto._olmDevice.deviceCurve25519Key,
                        ciphertext: {},
                    };
                    await olmlib.encryptMessageForDevice(
                        encryptedContent.ciphertext,
                        this._baseApis.getUserId(),
                        this._baseApis.deviceId,
                        this._baseApis._crypto._olmDevice,
                        sender,
                        this._baseApis._crypto.getStoredDevice(sender, deviceId),
                        payload,
                    );
                    const contentMap = {
                        [sender]: {
                            [deviceId]: encryptedContent,
                        },
                    };

                    this._baseApis.sendToDevice("m.room.encrypted", contentMap);
                },
            });
        }
    }

    _onSecretReceived(event) {
        if (event.getSender() !== this._baseApis.getUserId()) {
            // we shouldn't be receiving secrets from anyone else, so ignore
            // because someone could be trying to send us bogus data
            return;
        }
        const content = event.getContent();
        logger.log("got secret share for request ", content.request_id);
        const requestControl = this._requests[content.request_id];
        if (requestControl) {
            // make sure that the device that sent it is one of the devices that
            // we requested from
            const deviceInfo = this._baseApis._crypto._deviceList.getDeviceByIdentityKey(
                olmlib.OLM_ALGORITHM,
                event.getSenderKey(),
            );
            if (!deviceInfo) {
                logger.log(
                    "secret share from unknown device with key", event.getSenderKey(),
                );
                return;
            }
            if (!requestControl.devices.includes(deviceInfo.deviceId)) {
                logger.log("unsolicited secret share from device", deviceInfo.deviceId);
                return;
            }

            requestControl.resolve(content.secret);
        }
    }
}

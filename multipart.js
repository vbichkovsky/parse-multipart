/* jshint node: true */
'use strict';

const fs = require('fs');
const path = require('path');
const uniqueFilename = require('unique-filename');

const UPLOAD_PREFIX = 'multipart';

const isObject = (obj) => (typeof obj === 'object') && (obj !== null);
const emptyBuffer = () => Buffer.from('');

/**
    Multipart Parser (Finite State Machine)

    usage:

    const multipart = require('./multipart');
    const boundary = multipart.getBoundary(event.params.header['content-type']);
    const parts = multipart.parse(body, boundary);

    const middleware = multipart.middleware({
        dest: '/path/to/uploaded/files'
    });

    // each part is:
    // { filename: 'A.txt', type: 'text/plain', data: <Buffer 41 41 41 41 42 42 42 42> }

    original author:  Cristian Salazar (christiansalazarh@gmail.com) www.chileshift.cl
             Twitter: @AmazonAwsChile
    forked from:      "andreasantillana/parse-multipart" to support simple form data
    edited by:        "GALCF/parse-multipart" to support middlewares and JSHint with ES6
 */
const multipart = {
    parse: (multipartBodyBuffer, boundary) => {
        const process = part => {
            // will transform this object:
            // { header: 'Content-Disposition: form-data; name="uploads[]"; filename="A.txt"',
            //   info: 'Content-Type: text/plain',
            //   part: 'AAAABBBB' }
            // into this one:
            // { filename: 'A.txt', type: 'text/plain', data: <Buffer 41 41 41 41 42 42 42 42> }
            const obj = str => {
                const k = str.split('=');
                const a = k[0].trim();
                const b = JSON.parse(k[1].trim());
                const o = {};

                Object.defineProperty(o, a, {
                    value: b,
                    writable: true,
                    enumerable: true,
                    configurable: true
                });

                return o;
            };

            const header = part.header.split(';');

            if (part.fieldInfo !== null && part.fieldInfo !== '') {
                const field = obj(header[1]);

                Object.defineProperty(field, 'data', {
                    value: part.fieldInfo,
                    writable: true,
                    enumerable: true,
                    configurable: true
                });

                return field;
            }

            const file = obj(header[2]);
            const fileField = obj(header[1]);

            if (fileField.name) {
                Object.defineProperty(file, 'name', {
                    value: fileField.name,
                    writable: true,
                    enumerable: true,
                    configurable: true
                });
            }

            const contentType = part.info.split(':')[1].trim();

            Object.defineProperty(file, 'type', {
                value: contentType,
                writable: true,
                enumerable: true,
                configurable: true
            });

            Object.defineProperty(file, 'data', {
                value: Buffer.from(part.part),
                writable: true,
                enumerable: true,
                configurable: true
            });

            return file;
        };

        let lastline = emptyBuffer();
        let header = '';
        let info = '';
        let state = 0;
        let buffer = [];
        let allParts = [];
        let fieldInfo = '';

        for (let i = 0; i < multipartBodyBuffer.length; i++) {
            const oneByte = multipartBodyBuffer[i];
            const prevByte = i > 0 ? multipartBodyBuffer[i - 1] : null;
            const newLineDetected = (oneByte === 0x0a) && (prevByte === 0x0d);
            const newLineChar = (oneByte === 0x0a) || (oneByte === 0x0d);

            if (!newLineChar) {
                lastline = Buffer.concat([lastline, Buffer.from([oneByte])]);
            }

            if ((0 === state) && newLineDetected) {
                if (('--' + boundary) == lastline.toString()) {
                    state = 1;
                }
                lastline = emptyBuffer();
            } else if ((1 === state) && newLineDetected) {
                header = lastline.toString();
                state = 2;
                lastline = emptyBuffer();
            } else if ((2 === state) && newLineDetected) {
                info = lastline.toString();
                state = 3;
                lastline = emptyBuffer();
            } else if ((3 === state) && newLineDetected) {
                fieldInfo = lastline.toString();
                state = 4;
                buffer = [];
                lastline = emptyBuffer();
            } else if (4 === state) {
                if (lastline.length > (boundary.length + 4)) {
                    // mem save
                    lastline = emptyBuffer();
                }

                if (('--' + boundary) === lastline.toString()) {
                    const j = buffer.length - lastline.length;
                    const part = buffer.slice(0, j - 1);
                    const p = {
                        header: header,
                        info: info,
                        part: part,
                        fieldInfo: fieldInfo
                    };

                    allParts.push(process(p));
                    buffer = [];
                    lastline = emptyBuffer();
                    state = 5;
                    header = '';
                    info = '';
                } else {
                    buffer.push(oneByte);
                }

                if (newLineDetected) {
                    lastline = emptyBuffer();
                }
            } else if (5 === state) {
                if (newLineDetected) {
                    state = 1;
                }
            }
        }

        return allParts;
    },

    //  read the boundary from the content-type header sent by the http client
    //  this value may be similar to:
    //  'multipart/form-data; boundary=----WebKitFormBoundaryvm5A9tzU1ONaGP5B',
    getBoundary: header => {
        const items = header.split(';');

        if (items) {
            for (let i = 0; i < items.length; i++) {
                const item = (items[i] + '').trim();

                if (item.indexOf('boundary') >= 0) {
                    const k = item.split('=');
                    return (k[1] + '').trim();
                }
            }
        }

        return '';
    },

    middleware: options => {
        options = options || {};

        const mapFormData = (destination, part, asFile) => {
            const partData = asFile ? part : part.data;

            if (Array.isArray(destination[part.name])) {
                destination[part.name].push(partData);
            } else if (!destination[part.name]) {
                destination[part.name] = partData;
            } else {
                destination[part.name] = [destination[part.name], partData];
            }
        };

        return (req, res, next) => {
            const contentType = req.headers['content-type'];
            const boundary = multipart.getBoundary(contentType);
            const parts = multipart.parse(req.body, boundary);

            if (!parts) {
                return next();
            }

            // Map files to req.files and data to req.body
            req.files = isObject(req.files) ? req.files : {};
            req.fields = isObject(req.fields) ? req.fields : {};

            parts.forEach(part => {
                if (!part.name) {
                    return;
                }

                if (part.filename) {
                    mapFormData(req.files, part, true);
                } else {
                    mapFormData(req.fields, part, false);
                }
            });

            // Write files to disk, if options.dest is set
            if (options.dest) {
                parts.forEach(part => {
                    if (part.filename) {
                        const filepath = uniqueFilename(options.dest, UPLOAD_PREFIX);

                        part.path = path.resolve(filepath);

                        fs.writeFileSync(part.path, part.data);
                    }
                });
            }

            return next();
        };
    }
};

module.exports = multipart;


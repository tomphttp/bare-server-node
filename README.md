# TOMP Bare Server

This repository implements the TompHTTP bare server. [See the specification here](https://github.com/tomphttp/specifications/blob/master/BareServer.md).

## Upgrading

A updating guide for v1 to v2 can be found [at this upgrading guide](./docs/V2-UPGRADE-GUIDE.md).

## Usage

We provide a command-line interface for creating a server.

For more features, specify the `--help` option when running the CLI.

## Quickstart

1. Install Bare Server Node globally

```sh
npm install --global @tomphttp/bare-server-node
```

2. Start the server

```sh
npx bare-server-node
```

Optionally start the server localhost:8080:

```sh
npx bare-server-node --port 8080 --host localhost
```

## Programically create a bare server

See [examples folder](https://github.com/tomphttp/bare-server-node/tree/master/examples).

## Development

See the [wiki](https://github.com/tomphttp/bare-server-node/wiki).

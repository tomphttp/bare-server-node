# TOMP Bare Server

This repository implements the TompHTTP bare server. See the specification [here](https://github.com/tomphttp/specifications/blob/master/BareServerV1.md).

## Usage

We provide a command-line interface for creating a server.

For more features, specify the `--help` option when running the CLI.

### Quickstart

1. Clone the repository locally

```sh
git clone https://github.com/tomphttp/bare-server-node.git
```

2. Enter the folder

```sh
cd bare-server-node
```

3. Install dependencies

```sh
npm install
```

3. Start the server

```sh
node ./app.js server --port 80 --host localhost
```

/**
 * Example of using src/setupProxy.js to register a Bare server in your Create React App development server.
 * See https://create-react-app.dev/docs/proxying-api-requests-in-development/
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const { createBareServer } = require('@tomphttp/bare-server-node');

/**
 * Entry point called by react-scripts during development (npm start)
 * @param {import('express').Express} app
 */
function setupProxy(app) {
	const bareServer = createBareServer('/bare/');

	app.use((req, res, next) => {
		if (bareServer.shouldRoute(req)) bareServer.routeRequest(req, res);
		else next();
	});
}

module.exports = setupProxy;

try {
	const husky = await import('husky');
	husky.install();
} catch (error) {
	console.warn('Husky not installed');
}

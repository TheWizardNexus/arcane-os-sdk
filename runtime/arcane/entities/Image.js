import Is from 'strong-type';
const is=new Is(false);

import FileEntity from './File.js';

/**
 * ImageEntity
 *
 * Image-focused file entity built on top of DocumentEntity.
 *
 * Storage table:
 * - OPFS `images`
 *
 * Adds:
 * - image type validation helpers
 * - base64 data URL conversion
 * - blob URL creation/revocation helpers
 */
class ImageEntity extends FileEntity {

	/**
	 * Create an ImageEntity targeting OPFS `images` table.
	 *
	 * @param {string} fileName Optional existing OPFS file key.
	 */
	constructor(fileName = '', tableName='images') {
		super(fileName, tableName);
		return this;
	}

	/**
	 * Check whether a file is an accepted image type.
	 *
	 * Accepts MIME `image/*` or extension: png, jpg/jpeg, svg.
	 *
	 * @param {File|Object} file
	 * @returns {boolean}
	 */
	static isImageFile(file) {
		if (!file || !is.string(file.name)) {
			return false;
		}

		const hasImageMime = is.string(file.type) && file.type.startsWith('image/');
		const hasImageExt = /\.(png|jpe?g|svg)$/i.test(file.name);

		return hasImageMime || hasImageExt;
	}

	/**
	 * Strict PNG validator for PNG-only workflows.
	 *
	 * @param {File|Object} file
	 * @returns {boolean}
	 */
	static isPNGFile(file) {
		if (!file || !is.string(file.name)) {
			return false;
		}

		const lowerName = file.name.toLowerCase();
		const hasPngMime = is.string(file.type) && file.type.toLowerCase() === 'image/png';
		const hasPngExt = lowerName.endsWith('.png');

		return hasPngMime || hasPngExt;
	}

	/**
	 * Upload and persist an image file.
	 *
	 * @param {File} file
	 * @returns {Promise<ImageEntity>}
	 */
	async uploadFile(file) {
		if (!ImageEntity.isImageFile(file)) {
			throw new Error('ImageEntity.uploadFile expects an image file');
		}

		return super.uploadFile(file);
	}

	/**
	 * Save raw bytes to OPFS for current `storedAs` key.
	 *
	 * @param {ArrayBuffer} buffer
	 * @returns {Promise<void>}
	 */
	async save(buffer) {
		return super.save(buffer);
	}

	/**
	 * Convert stored image into a base64 data URL string.
	 *
	 * @returns {Promise<string>}
	 */
	async getBase64DataURL() {
		const file = await this.getFile();

		return await new Promise(
			(resolve, reject) => {
				const reader = new FileReader();

				reader.onload = () => resolve(reader.result);
				reader.onerror = () => reject(reader.error || new Error('Failed to encode image as data URL'));

				reader.readAsDataURL(file);
			}
		);
	}

	/**
	 * Create an object URL for the stored image.
	 *
	 * Caller should revoke the URL when done.
	 *
	 * @returns {Promise<string>}
	 */
	async getBlobURL() {
		const file = await this.getFile();
		return URL.createObjectURL(file);
	}

	/**
	 * Revoke a blob URL created for image preview.
	 *
	 * @param {string} url
	 * @returns {void}
	 */
	static revokeBlobURL(url = '') {
		if (is.string(url) && url.startsWith('blob:')) {
			URL.revokeObjectURL(url);
		}
	}

}

export default ImageEntity;

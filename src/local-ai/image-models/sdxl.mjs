/** Official complete SDXL checkpoint; acquisition belongs to the model asset owner. */
export const SDXL_BASE_1_0_MODEL = {
    id: 'sdxl-base-1.0',
    name: 'SDXL Base 1.0',
    family: 'sdxl',
    resources: {
        model: {
            url: 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/462165984030d82259a11f4367a4eed129e94a7b/sd_xl_base_1.0.safetensors',
            filename: 'sd_xl_base_1.0.safetensors'
        }
    },
    context: {},
    defaults: {
        width: 1024,
        height: 1024
    },
    operations: ['txt2img', 'img2img']
};

/** Official complete checkpoint; acquisition belongs to the model asset owner. */
export const SD14_MODEL = {
    id: 'sd14',
    name: 'Stable Diffusion 1.4',
    family: 'sd',
    resources: {
        model: {
            url: 'https://huggingface.co/CompVis/stable-diffusion-v-1-4-original/resolve/c96766dd476698a0ece589565635fafc88ebecae/sd-v1-4.ckpt',
            filename: 'sd-v1-4.ckpt'
        }
    },
    context: {},
    defaults: {},
    operations: ['txt2img']
};

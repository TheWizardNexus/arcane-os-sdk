/** Distilled Klein model resources; acquisition belongs to the model asset owner. */
export const FLUX2_KLEIN_4B_MODEL = {
    id: 'flux2-klein-4b',
    name: 'FLUX.2 Klein 4B',
    family: 'flux',
    resources: {
        diffusion_model: {
            url: 'https://huggingface.co/black-forest-labs/FLUX.2-klein-4B/resolve/e7b7dc27f91deacad38e78976d1f2b499d76a294/flux-2-klein-4b.safetensors',
            filename: 'flux-2-klein-4b.safetensors'
        },
        vae: {
            url: 'https://huggingface.co/black-forest-labs/FLUX.2-small-decoder/resolve/a3efc24f613ef42d9428af62fdbd6f5fd8856c4a/full_encoder_small_decoder.safetensors',
            filename: 'full_encoder_small_decoder.safetensors'
        },
        llm: {
            url: 'https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/bc640142c66e1fdd12af0bd68f40445458f3869b/Qwen3-4B-Q8_0.gguf',
            filename: 'Qwen3-4B-Q8_0.gguf'
        }
    },
    context: {},
    defaults: {
        sample_params: {
            sample_steps: 4,
            sample_method: 'euler',
            guidance: {
                txt_cfg: 1
            }
        }
    },
    operations: ['txt2img']
};

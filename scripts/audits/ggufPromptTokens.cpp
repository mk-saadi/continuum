// Vocabulary-only audit helper; no inference context or model tensors loaded.
#include "llama.h"
#include <iostream>
#include <iterator>
#include <vector>

int main(int argc, char ** argv) {
    if (argc < 2) return 1;
    auto params = llama_model_default_params();
    params.vocab_only = true;
    auto model = llama_model_load_from_file(argv[1], params);
    if (!model) return 1;
    if (argc > 2) {
        std::vector<char> buffer(100000);
        int size = llama_model_meta_val_str(model, "tokenizer.chat_template", buffer.data(), buffer.size());
        if (size < 0 || size >= (int) buffer.size()) { llama_model_free(model); return 1; }
        std::cout.write(buffer.data(), size);
    } else {
        auto vocab = llama_model_get_vocab(model);
        std::string text((std::istreambuf_iterator<char>(std::cin)), {});
        int size = llama_tokenize(vocab, text.data(), text.size(), nullptr, 0, false, true);
        std::vector<llama_token> tokens(size < 0 ? -size : size);
        size = llama_tokenize(vocab, text.data(), text.size(), tokens.data(), tokens.size(), false, true);
        if (size < 0) { llama_model_free(model); return 1; }
        std::cout << size << '\n';
    }
    llama_model_free(model);
}

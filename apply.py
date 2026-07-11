import sys
import os

def apply_patch(patch_file, project_root=None):
    if not os.path.exists(patch_file):
        print(f"Ошибка: Файл с изменениями {patch_file} не найден.")
        return

    if project_root is None:
        project_root = os.getcwd()

    with open(patch_file, 'r', encoding='utf-8') as f:
        patch_text = f.read()

    # Парсим блоки SEARCH / REPLACE
    # Формат: <<<<<<< SEARCH ./путь/к/файлу
    blocks = []
    state = 'TEXT'
    search_lines, replace_lines = [], []
    current_file = None

    for line in patch_text.splitlines():
        stripped = line.strip()

        if stripped.startswith('<<<<<<< SEARCH'):
            state = 'SEARCH'
            search_lines = []
            # Извлекаем путь к файлу из маркера
            parts = stripped.split('<<<<<<< SEARCH', 1)
            file_path = parts[1].strip() if len(parts) > 1 else ''
            if file_path:
                current_file = file_path
            else:
                current_file = None

        elif stripped == '=======' and state == 'SEARCH':
            state = 'REPLACE'
            replace_lines = []

        elif stripped == '>>>>>>> REPLACE' and state == 'REPLACE':
            state = 'TEXT'
            blocks.append({
                'file': current_file,
                'search': '\n'.join(search_lines),
                'replace': '\n'.join(replace_lines),
            })

        elif state == 'SEARCH':
            search_lines.append(line)
        elif state == 'REPLACE':
            replace_lines.append(line)

    if not blocks:
        print("Блоки '<<<<<<< SEARCH' не найдены в файле изменений.")
        return

    # Группируем блоки по файлам
    files_cache = {}

    for i, block in enumerate(blocks, 1):
        rel_path = block['file']
        search_text = block['search']
        replace_text = block['replace']

        if not rel_path:
            print(f"❌ Ошибка в блоке {i}: Не указан путь к файлу в маркере SEARCH.")
            continue

        # Нормализуем путь
        target_file = os.path.normpath(os.path.join(project_root, rel_path))

        if target_file not in files_cache:
            if not os.path.exists(target_file):
                print(f"❌ Ошибка в блоке {i}: Файл {rel_path} не найден.")
                continue
            with open(target_file, 'r', encoding='utf-8') as f:
                files_cache[target_file] = f.read()

        content = files_cache[target_file]

        if search_text not in content:
            print(f"❌ Ошибка в блоке {i} ({rel_path}): Текст для замены не найден в файле (возможно, не совпадают отступы).")
            continue
        if content.count(search_text) > 1:
            print(f"❌ Ошибка в блоке {i} ({rel_path}): Этот кусок кода встречается в файле несколько раз. Нужен больший контекст.")
            continue

        files_cache[target_file] = content.replace(search_text, replace_text)
        print(f"✅ Блок {i} ({rel_path}) успешно применен!")

    # Сохраняем все измененные файлы
    for target_file, content in files_cache.items():
        with open(target_file, 'w', encoding='utf-8') as f:
            f.write(content)
        rel = os.path.relpath(target_file, project_root)
        print(f"💾 Файл {rel} сохранен.")

    print(f"\n🎉 Готово!")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Использование: py apply.py <файл_с_ответом_нейросети.txt> [папка_проекта]")
        print("Пути к файлам берутся из маркеров: <<<<<<< SEARCH ./путь/к/файлу")
    else:
        patch = sys.argv[1]
        root = sys.argv[2] if len(sys.argv) > 2 else os.getcwd()
        apply_patch(patch, root)

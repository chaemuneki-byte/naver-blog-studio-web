from pathlib import Path
import zipfile
root=Path(__file__).resolve().parent.parent
(root/'extension'/'core.js').write_bytes((root/'docs'/'core.js').read_bytes())
with zipfile.ZipFile(root/'docs'/'naver-blog-connector.zip','w',zipfile.ZIP_DEFLATED) as archive:
    for file in sorted((root/'extension').glob('*')):
        if file.is_file():
            archive.write(file,file.name)
print('docs/naver-blog-connector.zip ready')

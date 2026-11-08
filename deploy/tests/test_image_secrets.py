import gzip
import io
import os
import pathlib
import shutil
import subprocess
import tarfile
import tempfile
import unittest
import uuid


class ImageSecretsTest(unittest.TestCase):
    def test_environment_files_do_not_enter_image_layers(self):
        root = pathlib.Path(__file__).resolve().parents[2]
        secret = b'ISSUE106_SYNTHETIC_SECRET_CANARY_36D7'
        control = b'ISSUE106_PUBLIC_CONTROL_CANARY_71D2'
        with tempfile.TemporaryDirectory(prefix='issue106-image-') as temp:
            target = pathlib.Path(temp)
            for name in ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'Dockerfile', '.dockerignore']:
                shutil.copy2(root / name, target / name)
            for name in ['apps', 'packages', 'deploy']:
                shutil.copytree(root / name, target / name, ignore=shutil.ignore_patterns('node_modules', 'dist', '.env', '.env.*', 'coverage', 'test-results'))
            (target / '.env.issue106-canary').write_bytes(secret)
            (target / 'apps' / 'office' / '.env.issue106-canary').write_bytes(secret)
            (target / 'apps' / 'driver' / '.env.issue106-canary').write_bytes(secret)
            (target / 'packages' / 'api' / 'issue106-control.txt').write_bytes(control)
            for app in ['office', 'driver']:
                public = target / 'apps' / app / 'public'
                public.mkdir(exist_ok=True)
                (public / 'issue106-control.txt').write_bytes(control)
            for image_target in ['api', 'office', 'driver']:
                with self.subTest(image=image_target):
                    tag = 'issue106-canary:' + uuid.uuid4().hex
                    if os.name == 'nt':
                        subprocess.run([r'C:\Program Files\Git\bin\bash.exe', '-c', 'df -h /c'], check=True)
                    else:
                        subprocess.run(['df', '-h', '.'], check=True)
                    self.assertGreaterEqual(shutil.disk_usage(root).free, int(1.5 * 1024 ** 3))
                    try:
                        subprocess.run(['docker', 'build', '--target', image_target, '-t', tag, str(target)], check=True)
                        proc = subprocess.Popen(['docker', 'save', tag], stdout=subprocess.PIPE)
                        found_secret = found_control = False
                        with tarfile.open(fileobj=proc.stdout, mode='r|') as archive:
                            for member in archive:
                                if not member.isfile():
                                    continue
                                stream = io.BufferedReader(archive.extractfile(member))
                                if stream.peek(2)[:2] == b'\x1f\x8b':
                                    stream = gzip.GzipFile(fileobj=stream)
                                tail = b''
                                while True:
                                    chunk = stream.read(1024 * 1024)
                                    if not chunk:
                                        break
                                    data = tail + chunk
                                    found_secret |= secret in data
                                    found_control |= control in data
                                    tail = data[-max(len(secret), len(control)):]
                        proc.stdout.close()
                        self.assertEqual(proc.wait(), 0)
                        self.assertTrue(found_control, 'positive control must appear in the image archive')
                        self.assertFalse(found_secret, 'environment file contents leaked into the image archive')
                    finally:
                        subprocess.run(['docker', 'image', 'rm', tag], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == '__main__':
    unittest.main()

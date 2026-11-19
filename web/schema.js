/** A small JSON Schema editor. Complex unions stay available in the lossless JSON tab. */
export function createSchemaEditor(container, rootSchema, initial = {}, onChange = () => {}) {
  container.replaceChildren();
  let nextId = 0;
  function resolve(schema) {
    if (schema.$ref?.startsWith('#/')) {
      const found = schema.$ref
        .slice(2)
        .split('/')
        .reduce(
          (value, key) => value?.[key.replaceAll('~1', '/').replaceAll('~0', '~')],
          rootSchema,
        );
      return found ? { ...found, ...schema, $ref: undefined } : schema;
    }
    return schema;
  }
  function input(schema, value, path, depth = 0) {
    schema = resolve(schema);
    const union = schema.oneOf ?? schema.anyOf;
    if (union) {
      const choices = union.filter((s) => s.type !== 'null');
      if (choices.every((s) => s.const !== undefined))
        schema = {
          ...schema,
          enum: choices.map((s) => s.const),
          enumNames: choices.map((s) => s.title ?? String(s.const)),
        };
      else if (choices.length === 1)
        schema = { ...schema, ...choices[0], anyOf: undefined, oneOf: undefined };
      else return jsonInput(value, path, schema);
    }
    if (schema.const !== undefined) {
      const node = document.createElement('input');
      node.value = JSON.stringify(schema.const);
      node.readOnly = true;
      return { node, read: () => schema.const };
    }
    if (schema.enum) {
      const node = document.createElement('select');
      for (const [index, item] of schema.enum.entries()) {
        const option = new Option(schema.enumNames?.[index] ?? String(item), String(index));
        node.add(option);
      }
      const index = schema.enum.findIndex(
        (item) => JSON.stringify(item) === JSON.stringify(value ?? schema.default),
      );
      node.value = String(Math.max(index, 0));
      node.addEventListener('change', onChange);
      return { node, read: () => schema.enum[Number(node.value)] };
    }
    const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
    if (
      (type === 'object' || schema.properties) &&
      depth < 8 &&
      (schema.properties || schema.additionalProperties === false)
    ) {
      const node = document.createElement('div');
      if (depth) node.className = 'nested';
      const children = Object.entries(schema.properties ?? {}).map(([key, child]) => {
        const field = document.createElement('div');
        field.className = 'field';
        const header = document.createElement('div');
        header.className = 'field-header';
        const id = 'schema-field-' + ++nextId;
        const label = document.createElement('label');
        label.textContent = key;
        label.htmlFor = id;
        header.append(label);
        const required = schema.required?.includes(key);
        let include;
        if (!required) {
          const toggle = document.createElement('label');
          toggle.className = 'include';
          include = document.createElement('input');
          include.type = 'checkbox';
          include.checked = value?.[key] !== undefined;
          toggle.append(include, 'include');
          header.append(toggle);
        }
        field.append(header);
        const control = input(child, value?.[key] ?? child.default, path + '.' + key, depth + 1);
        const first = control.node.matches('input,select,textarea')
          ? control.node
          : control.node.querySelector('input,select,textarea');
        if (first) {
          first.id = id;
          first.setAttribute('aria-label', path ? path + '.' + key : key);
        }
        field.append(control.node);
        if (child.description) {
          const help = document.createElement('p');
          help.className = 'field-description';
          help.textContent = child.description;
          field.append(help);
        }
        if (include) {
          const update = () => {
            control.node.style.opacity = include.checked ? '1' : '.5';
          };
          include.addEventListener('change', () => {
            update();
            onChange();
          });
          control.node.addEventListener('input', () => {
            include.checked = true;
            update();
          });
          control.node.addEventListener('change', (event) => {
            if (event.target !== include) {
              include.checked = true;
              update();
            }
          });
          update();
        }
        node.append(field);
        return () => (required || include.checked ? [key, control.read()] : null);
      });
      return {
        node,
        read: () => Object.fromEntries(children.map((read) => read()).filter(Boolean)),
      };
    }
    if (type === 'array' && schema.items && !Array.isArray(schema.items) && depth < 8) {
      const node = document.createElement('div');
      const rows = [];
      const add = document.createElement('button');
      add.type = 'button';
      add.textContent = '+ Add item';
      const addRow = (value) => {
        const row = document.createElement('div');
        row.className = 'array-row';
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = 'Remove item';
        const control = input(schema.items, value, path + '[]', depth + 1);
        row.append(remove, control.node);
        node.insertBefore(row, add);
        rows.push({ row, control });
        remove.onclick = () => {
          rows.splice(
            rows.findIndex((item) => item.row === row),
            1,
          );
          row.remove();
          onChange();
        };
      };
      add.onclick = () => {
        addRow(undefined);
        node.dispatchEvent(new Event('input', { bubbles: true }));
        onChange();
      };
      node.append(add);
      let readingFiles = false;
      const properties = resolve(schema.items).properties;
      if (properties?.name?.type === 'string' && properties?.contentBase64?.type === 'string') {
        const picker = document.createElement('input');
        picker.type = 'file';
        picker.multiple = true;
        picker.setAttribute('aria-label', 'Attach local files');
        const status = document.createElement('span');
        status.setAttribute('role', 'status');
        picker.onchange = async () => {
          const files = Array.from(picker.files);
          if (!files.length) return;
          picker.disabled = readingFiles = true;
          status.textContent = 'Reading files…';
          try {
            const attachments = await Promise.all(files.map(readAttachment));
            for (const attachment of attachments) addRow(attachment);
            status.textContent = '';
            readingFiles = false;
            node.dispatchEvent(new Event('input', { bubbles: true }));
            onChange();
          } catch (error) {
            status.textContent = error.message;
          } finally {
            picker.disabled = readingFiles = false;
            picker.value = '';
          }
        };
        node.prepend(picker, status);
      }
      for (const item of Array.isArray(value) ? value : []) addRow(item);
      return {
        node,
        read: () => {
          if (readingFiles) throw new Error('Wait for the selected files to finish loading.');
          return rows.map((row) => row.control.read());
        },
      };
    }
    if (type === 'boolean') {
      const node = document.createElement('select');
      node.add(new Option('false', 'false'));
      node.add(new Option('true', 'true'));
      node.value = String(value ?? schema.default ?? false);
      node.addEventListener('change', onChange);
      return { node, read: () => node.value === 'true' };
    }
    if (['integer', 'number'].includes(type)) {
      const node = document.createElement('input');
      node.type = 'number';
      node.step = type === 'integer' ? '1' : 'any';
      node.value = value === undefined ? '' : String(value);
      if (schema.minimum !== undefined) node.min = schema.minimum;
      if (schema.maximum !== undefined) node.max = schema.maximum;
      node.addEventListener('input', onChange);
      return {
        node,
        read: () => {
          if (!node.value.trim()) throw new Error(`Enter a number for ${path}`);
          return Number(node.value);
        },
      };
    }
    if (type === 'string') {
      const node = document.createElement(
        schema.format === 'textarea' || /message|text|content|description|prompt/i.test(path)
          ? 'textarea'
          : 'input',
      );
      node.value = value ?? '';
      node.spellcheck = false;
      node.addEventListener('input', onChange);
      return { node, read: () => node.value };
    }
    return jsonInput(value, path, schema);
  }
  function jsonInput(value, path, schema) {
    const node = document.createElement('textarea');
    node.spellcheck = false;
    node.value = JSON.stringify(
      value ?? schema.default ?? (schema.type === 'array' ? [] : {}),
      null,
      2,
    );
    node.addEventListener('input', onChange);
    return {
      node,
      read: () => {
        try {
          return JSON.parse(node.value);
        } catch {
          throw new Error(`Invalid JSON in ${path || 'arguments'}`);
        }
      },
    };
  }
  const control = input(rootSchema, initial, '');
  container.append(control.node);
  return { read: control.read };
}

function readAttachment(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = reader.result;
      resolve({ name: file.name, contentBase64: url.slice(url.indexOf(',') + 1) });
    };
    reader.onerror = () => reject(new Error('Could not read ' + file.name));
    reader.readAsDataURL(file);
  });
}

'use client';

import { FC, useCallback, useRef, useState } from 'react';
import { useFormContext } from 'react-hook-form';
import { Input } from '@gitroom/react/form/input';
import { Textarea } from '@gitroom/react/form/textarea';
import { Select } from '@gitroom/react/form/select';
import { Checkbox } from '@gitroom/react/form/checkbox';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';

/** Mirrors StudioParamField in the backend catalog. */
export interface StudioFieldSpec {
  name: string;
  label: string;
  type: 'text' | 'textarea' | 'select' | 'number' | 'boolean' | 'media';
  description?: string;
  required?: boolean;
  maxLength?: number;
  placeholder?: string;
  default?: any;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  accept?: 'image' | 'video';
}

interface Picked {
  id: string;
  path: string;
}

/**
 * Upload control for reference images.
 *
 * Deliberately NOT the post editor's MultiMediaComponent. That component is
 * built for the composer: it renders the whole media toolbar - Insert Media,
 * Design Media, AI Image, AI Video - and carries the composer's assumptions
 * with it. Dropped into a Studio parameter form it reads as clutter, and the
 * one thing a reference-image field has to do, show an obvious way to add a
 * file, is the thing it does least clearly.
 *
 * This posts straight to /media/upload-simple, so the file lands in the Media
 * library and the model receives a public URL - which is what kie.ai needs,
 * since it fetches reference images by URL rather than accepting bytes.
 */
const StudioMediaInput: FC<{ field: StudioFieldSpec }> = ({ field }) => {
  const fetch = useFetch();
  const { watch, setValue } = useFormContext();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');

  const value: Picked[] = watch(field.name) || [];
  const max = field.max ?? 1;
  const full = value.length >= max;

  const upload = useCallback(
    async (files: FileList | null) => {
      if (!files?.length) {
        return;
      }
      setBusy(true);
      setFailed('');
      const next = [...value];
      try {
        for (const file of Array.from(files).slice(0, max - value.length)) {
          const body = new FormData();
          body.append('file', file);
          // custom.fetch omits Content-Type for FormData, so the browser sets
          // the multipart boundary itself.
          const res = await fetch('/media/upload-simple', {
            method: 'POST',
            body,
          });
          if (res.status !== 200 && res.status !== 201) {
            setFailed(`${file.name} could not be uploaded`);
            continue;
          }
          const saved = await res.json();
          if (saved?.path) {
            next.push({ id: saved.id, path: saved.path });
          }
        }
        setValue(field.name, next, { shouldValidate: true });
      } finally {
        setBusy(false);
        if (inputRef.current) {
          // Let the same file be chosen again after a removal.
          inputRef.current.value = '';
        }
      }
    },
    [value, max, field.name, setValue]
  );

  const remove = useCallback(
    (index: number) => {
      setValue(
        field.name,
        value.filter((_, i) => i !== index),
        { shouldValidate: true }
      );
    },
    [value, field.name, setValue]
  );

  return (
    <div className="flex flex-col gap-[8px]">
      <div className="text-[14px]">
        {field.label}
        {field.required && <span className="text-red-400"> *</span>}
        {max > 1 && (
          <span className="text-textItemBlur">
            {' '}
            ({value.length}/{max})
          </span>
        )}
      </div>

      {!!field.description && (
        <div className="text-[12px] text-textItemBlur">{field.description}</div>
      )}

      {!!value.length && (
        <div className="flex flex-wrap gap-[8px]">
          {value.map((m, i) => (
            <div key={`${m.path}-${i}`} className="relative">
              <img
                src={m.path}
                alt=""
                className="w-[76px] h-[76px] object-cover rounded-[6px] border border-newTableBorder"
              />
              <button
                type="button"
                onClick={() => remove(i)}
                aria-label="Remove"
                className="absolute -top-[6px] -end-[6px] w-[20px] h-[20px] rounded-full bg-newColColor border border-newTableBorder text-[12px] leading-none"
              >
                &times;
              </button>
            </div>
          ))}
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        multiple={max > 1}
        accept={field.accept === 'video' ? 'video/*' : 'image/*'}
        disabled={busy || full}
        onChange={(e) => upload(e.target.files)}
        className="block w-full text-[13px] text-textItemBlur file:me-[10px] file:px-[12px] file:py-[7px] file:rounded-[6px] file:border file:border-newTableBorder file:bg-newColColor file:text-textColor file:text-[13px] file:cursor-pointer disabled:opacity-50"
      />

      {busy && (
        <div className="text-[12px] text-textItemBlur">Uploading...</div>
      )}
      {!!failed && <div className="text-[12px] text-red-300">{failed}</div>}
      {full && !busy && (
        <div className="text-[12px] text-textItemBlur">
          Remove one to add another.
        </div>
      )}
    </div>
  );
};

/**
 * Renders one catalog field.
 *
 * This is the piece that makes the catalog worth having: the server describes
 * a model's inputs, and the form builds itself. No per-model React component,
 * which is what the old videos/ registry required.
 */
export const StudioField: FC<{ field: StudioFieldSpec }> = ({ field }) => {
  const { register, setValue, formState } = useFormContext();
  const error = formState?.errors?.[field.name]?.message as string | undefined;

  if (field.type === 'media') {
    return <StudioMediaInput field={field} />;
  }

  if (field.type === 'boolean') {
    return (
      <Checkbox
        name={field.name}
        label={field.label}
        onChange={(e) => setValue(field.name, e.target.value)}
      />
    );
  }

  if (field.type === 'select') {
    return (
      <Select
        label={field.label}
        error={error}
        {...register(field.name, { value: field.default })}
      >
        {(field.options || []).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    );
  }

  if (field.type === 'textarea') {
    return (
      <Textarea
        label={field.label}
        placeholder={field.placeholder}
        error={error}
        {...register(field.name, {
          required: field.required ? `${field.label} is required` : false,
          maxLength: field.maxLength
            ? {
                value: field.maxLength,
                message: `${field.label} must be ${field.maxLength} characters or fewer`,
              }
            : undefined,
          value: field.default,
        })}
      />
    );
  }

  return (
    <Input
      label={field.label}
      type={field.type === 'number' ? 'number' : 'text'}
      placeholder={field.placeholder}
      error={error}
      {...register(field.name, {
        required: field.required ? `${field.label} is required` : false,
        value: field.default,
      })}
    />
  );
};

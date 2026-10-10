<?php

declare(strict_types=1);

namespace App\Models;

use App\Enums\PostStatus;
use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;

class BlogPost extends Model
{
    use HasUuids;

    /** @var list<string> */
    protected $fillable = [
        'public_id',
        'title',
        'body',
        'status',
        'rating',
        'view_count',
        'is_featured',
        'published_at',
        'metadata',
        'author_id',
        'editor_id',
        'category_id',
    ];

    /** @var array<string, string> */
    protected $casts = [
        'status' => PostStatus::class,
        'rating' => 'decimal:2',
        'is_featured' => 'boolean',
        'published_at' => 'datetime',
        'metadata' => 'array',
    ];

    /** @return list<string> */
    public function uniqueIds(): array
    {
        return ['public_id'];
    }

    /** @return BelongsTo<BlogUser, $this> */
    public function author(): BelongsTo
    {
        return $this->belongsTo(BlogUser::class);
    }

    /** @return BelongsTo<BlogUser, $this> */
    public function editor(): BelongsTo
    {
        return $this->belongsTo(BlogUser::class);
    }

    /** @return BelongsTo<BlogCategory, $this> */
    public function category(): BelongsTo
    {
        return $this->belongsTo(BlogCategory::class);
    }

    /** @return BelongsToMany<BlogTag, $this> */
    public function tags(): BelongsToMany
    {
        return $this->belongsToMany(BlogTag::class);
    }
}

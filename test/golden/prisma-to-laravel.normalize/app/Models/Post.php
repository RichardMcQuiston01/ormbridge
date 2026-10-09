<?php

declare(strict_types=1);

namespace App\Models;

use App\Enums\PostStatus;
use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Post extends Model
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

    /** @return BelongsTo<User, $this> */
    public function author(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    /** @return BelongsTo<User, $this> */
    public function editor(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    /** @return BelongsTo<Category, $this> */
    public function category(): BelongsTo
    {
        return $this->belongsTo(Category::class);
    }

    /** @return HasMany<PostTags, $this> */
    public function tags(): HasMany
    {
        return $this->hasMany(PostTags::class);
    }
}

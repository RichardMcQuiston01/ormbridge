<?php

declare(strict_types=1);

namespace App\Models;

use App\Enums\PostStatus;
use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;

class Post extends Model
{
    use HasUuids;

    protected $table = 'blog_post';

    protected $primaryKey = 'Id';

    /** @var list<string> */
    protected $fillable = [
        'public_id',
        'Title',
        'Body',
        'Status',
        'Rating',
        'view_count',
        'is_featured',
        'published_at',
        'Metadata',
        'author_id',
        'editor_id',
        'category_id',
    ];

    /** @var array<string, string> */
    protected $casts = [
        'Status' => PostStatus::class,
        'Rating' => 'decimal:2',
        'is_featured' => 'boolean',
        'published_at' => 'datetime',
        'Metadata' => 'array',
    ];

    /** @return list<string> */
    public function uniqueIds(): array
    {
        return ['public_id'];
    }

    /** @return BelongsTo<User, $this> */
    public function author(): BelongsTo
    {
        return $this->belongsTo(User::class, 'author_id');
    }

    /** @return BelongsTo<User, $this> */
    public function editor(): BelongsTo
    {
        return $this->belongsTo(User::class, 'editor_id');
    }

    /** @return BelongsTo<Category, $this> */
    public function category(): BelongsTo
    {
        return $this->belongsTo(Category::class, 'category_id');
    }

    /** @return BelongsToMany<Tag, $this> */
    public function tags(): BelongsToMany
    {
        return $this->belongsToMany(Tag::class, 'blog_post_tags', 'post_Id', 'tag_Id');
    }
}

<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;

class BlogTag extends Model
{
    protected $table = 'blog_tag';

    public $timestamps = false;

    /** @var list<string> */
    protected $fillable = [
        'label',
    ];

    /** @return BelongsToMany<BlogPost, $this> */
    public function blogPosts(): BelongsToMany
    {
        return $this->belongsToMany(BlogPost::class, 'blog_post_tags', 'blog_tag_id', 'blog_post_id');
    }
}

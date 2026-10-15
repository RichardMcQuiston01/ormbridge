<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;

class Tag extends Model
{
    protected $table = 'blog_tag';

    protected $primaryKey = 'Id';

    public $timestamps = false;

    /** @var list<string> */
    protected $fillable = [
        'Label',
    ];

    /** @return BelongsToMany<Post, $this> */
    public function posts(): BelongsToMany
    {
        return $this->belongsToMany(Post::class, 'blog_post_tags', 'tag_Id', 'post_Id');
    }
}

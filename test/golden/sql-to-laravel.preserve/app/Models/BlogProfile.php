<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class BlogProfile extends Model
{
    protected $table = 'blog_profile';

    public $timestamps = false;

    /** @var list<string> */
    protected $fillable = [
        'bio',
        'avatar',
        'user_id',
    ];

    /** @return BelongsTo<BlogUser, $this> */
    public function user(): BelongsTo
    {
        return $this->belongsTo(BlogUser::class);
    }
}

<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\Relations\HasOne;

class User extends Model
{
    protected $table = 'auth_user';

    public $timestamps = false;

    /** @var list<string> */
    protected $fillable = [];

    /** @return HasMany<Post, $this> */
    public function posts(): HasMany
    {
        return $this->hasMany(Post::class, 'author_id');
    }

    /** @return HasMany<Post, $this> */
    public function editedPosts(): HasMany
    {
        return $this->hasMany(Post::class, 'editor_id');
    }

    /** @return HasOne<Profile, $this> */
    public function profile(): HasOne
    {
        return $this->hasOne(Profile::class);
    }
}

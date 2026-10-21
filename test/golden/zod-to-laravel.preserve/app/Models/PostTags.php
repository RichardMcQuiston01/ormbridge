<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class PostTags extends Model
{
    protected $table = 'PostTags';

    public $incrementing = false;

    public $timestamps = false;

    /** @var list<string> */
    protected $fillable = [
        'id',
        'post_id',
        'tag_id',
    ];
}
